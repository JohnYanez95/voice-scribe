// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

/// Embedded audio cue WAV files — compiled into the binary from the shared
/// source in apps/web/public/sounds/. Same files the browser path serves
/// via Vite. Generator script: ops/scripts/generate_sounds.py.
const COPY_WAV: &[u8] = include_bytes!("../../../../apps/web/public/sounds/copy.wav");
const CLEAR_WAV: &[u8] = include_bytes!("../../../../apps/web/public/sounds/clear.wav");

/// Managed state: holds the sidecar child process handle so shutdown can
/// reach it from any context (window close, app exit).
struct Sidecar(Mutex<Option<Child>>);

/// Resolve the path to uvicorn. Tries the venv first, falls back to PATH.
fn find_uvicorn(api_dir: &std::path::Path) -> String {
    let venv_uvicorn = api_dir.join(".venv/bin/uvicorn");
    if venv_uvicorn.exists() {
        venv_uvicorn.to_string_lossy().to_string()
    } else {
        // Fall back to system uvicorn on PATH
        "uvicorn".to_string()
    }
}

/// Build LD_LIBRARY_PATH so the sidecar can dlopen CUDA runtime libraries
/// (e.g. libcublas.so.12) installed as pip packages under site-packages/nvidia/.
/// Without this, ctranslate2 fails at inference time on bare-host GPU setups.
///
/// Scans two locations in order:
///   1. Venv site-packages (pip install nvidia-cublas-cu12 inside .venv)
///   2. User-scope site-packages (pip install --user nvidia-cublas-cu12)
/// Either installation scope works. The host-setup doc explains both paths.
fn cuda_ld_library_path(api_dir: &std::path::Path) -> String {
    let mut paths: Vec<String> = Vec::new();

    // 1. Scan venv site-packages — getsitepackages() returns a list, so
    //    '\n'.join() + lines() iteration is safe without an isinstance guard.
    let venv_python = api_dir.join(".venv/bin/python");
    if venv_python.exists() {
        let output = Command::new(venv_python.to_string_lossy().as_ref())
            .args(["-c", "import site; print('\\n'.join(site.getsitepackages()))"])
            .output();
        if let Ok(out) = output {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                scan_nvidia_libs(line.trim(), &mut paths);
            }
        }
    }

    // 2. Scan user-scope site-packages — getusersitepackages() returns a string
    //    on most installations, hence the isinstance guard wrapping it in a list.
    let output = Command::new("python3")
        .args(["-c", "import site; print('\\n'.join(site.getusersitepackages() if isinstance(site.getusersitepackages(), list) else [site.getusersitepackages()]))"])
        .output();
    if let Ok(out) = output {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            scan_nvidia_libs(line.trim(), &mut paths);
        }
    }

    // 3. Preserve existing LD_LIBRARY_PATH
    if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
        paths.push(existing);
    }

    let resolved = paths.join(":");
    eprintln!("Sidecar LD_LIBRARY_PATH: {}", &resolved);
    resolved
}

/// Scan a site-packages directory for nvidia/*/lib/ subdirectories and append
/// any found paths to the collector.
fn scan_nvidia_libs(site_dir: &str, paths: &mut Vec<String>) {
    if site_dir.is_empty() {
        return;
    }
    let nvidia_dir = std::path::PathBuf::from(site_dir).join("nvidia");
    if nvidia_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&nvidia_dir) {
            for entry in entries.flatten() {
                let lib_dir = entry.path().join("lib");
                if lib_dir.is_dir() {
                    paths.push(lib_dir.to_string_lossy().to_string());
                }
            }
        }
    }
}

const SIDECAR_PID_FILE: &str = "/tmp/voice-scribe-sidecar.pid";

/// Spawn the Python API sidecar. Returns the child process handle.
/// Writes the sidecar PID to a temp file so the Makefile cleanup can
/// kill it on Ctrl+C (SIGINT doesn't trigger Tauri window events).
fn spawn_sidecar(api_dir: &std::path::Path) -> Result<Child, String> {
    let uvicorn = find_uvicorn(api_dir);
    let ld_path = cuda_ld_library_path(api_dir);

    let child = Command::new(&uvicorn)
        .args(["app.main:app", "--host", "127.0.0.1", "--port", "8084"])
        .current_dir(api_dir)
        .env("LD_LIBRARY_PATH", &ld_path)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar ({}): {}", uvicorn, e))?;

    // Write PID file for Makefile cleanup fallback
    let _ = std::fs::write(SIDECAR_PID_FILE, child.id().to_string());

    Ok(child)
}

/// Poll GET /health until 200 or timeout. Returns Ok(()) on success,
/// Err(message) on timeout or sidecar crash.
fn wait_for_health(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    let poll_interval = Duration::from_millis(500);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    loop {
        // Check if sidecar crashed
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Sidecar exited during startup with status: {}. \
                     Port 8084 may be in use by another process.",
                    status
                ));
            }
            Ok(None) => {} // still running
            Err(e) => return Err(format!("Failed to check sidecar status: {}", e)),
        }

        // Try health endpoint
        if let Ok(resp) = client.get("http://127.0.0.1:8084/health").send() {
            if resp.status().is_success() {
                return Ok(());
            }
        }

        if start.elapsed() > timeout {
            return Err(format!(
                "Backend did not become healthy within {} seconds. \
                 This may be normal on first run (model download).",
                timeout.as_secs()
            ));
        }

        thread::sleep(poll_interval);
    }
}

/// Kill the sidecar process. SIGTERM first, SIGKILL after 5s if needed.
/// Removes the PID file on completion.
fn kill_sidecar(child: &mut Child) {
    let _ = std::fs::remove_file(SIDECAR_PID_FILE);
    // Attempt graceful shutdown
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    // Wait up to 5 seconds for graceful exit
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return, // exited
            Ok(None) => {
                if Instant::now() > deadline {
                    // Force kill
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return,
        }
    }
}

/// Play a WAV file from an in-memory buffer via the default audio output.
/// Blocks until playback finishes (Sink::sleep_until_end), so callers should
/// run this in a spawned thread to avoid blocking the HTTP server.
fn play_wav(data: &'static [u8]) -> Result<(), String> {
    let cursor = std::io::Cursor::new(data);
    let source = rodio::Decoder::new(cursor)
        .map_err(|e| format!("WAV decode failed: {}", e))?;
    let (_stream, handle) = rodio::OutputStream::try_default()
        .map_err(|e| format!("Audio output failed: {}", e))?;
    let sink = rodio::Sink::try_new(&handle)
        .map_err(|e| format!("Sink creation failed: {}", e))?;
    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Clipboard write via HTTP + arboard.
        // The Tauri clipboard plugin (tauri-plugin-clipboard-manager) was tested
        // and confirmed to crash WebKitGTK with a NeedDebuggerBreak trap when
        // called without user activation (voice commands fire from WebSocket
        // callbacks — no user gesture). The HTTP server bypasses WebKitGTK
        // entirely: fetch() POST has no activation requirement, and arboard
        // writes to the system clipboard from the Rust process.
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // Resolve the API directory relative to CARGO_MANIFEST_DIR
            // (apps/desktop/src-tauri → ../../api → apps/api).
            // This is a compile-time constant — always correct in dev builds.
            // Production bundling (resource_dir) is not in scope until v3.1+.
            let api_dir =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../api");

            let api_dir = api_dir
                .canonicalize()
                .unwrap_or_else(|_| api_dir.clone());

            if !api_dir.join("app/main.py").exists() {
                return Err(format!(
                    "API directory not found at {}. Expected apps/api/app/main.py.",
                    api_dir.display()
                )
                .into());
            }

            // Grant microphone access to the webview. WebKitGTK has a two-layer
            // permission model: (1) feature gate via WebKitSettings, and
            // (2) runtime grant via the permission-request signal. Without both,
            // getUserMedia is denied silently.
            #[cfg(target_os = "linux")]
            {
                use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt};
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        let wk = webview.inner();

                        // Layer 1: enable the feature
                        let settings: webkit2gtk::Settings = WebViewExt::settings(&wk).unwrap();
                        SettingsExt::set_enable_media_stream(&settings, true);
                        SettingsExt::set_enable_media_capabilities(&settings, true);

                        // Layer 2: auto-grant permission requests (getUserMedia).
                        // Local-first tool — no untrusted content, safe to allow all.
                        wk.connect_permission_request(|_wv, request| {
                            request.allow();
                            true
                        });
                    });
                }
            }


            // Clipboard HTTP endpoint on 127.0.0.1:8001.
            // WebKitGTK gates all Tauri IPC (invoke / emit) on user activation.
            // Voice commands fire from WebSocket callbacks — no user gesture — so
            // every JS→Rust path through window.webkit.messageHandlers is blocked.
            // A plain fetch() POST bypasses WebKitGTK entirely: the request travels
            // over TCP to this listener, arboard writes to the system clipboard,
            // and the browser never sees a clipboard operation.
            let server = tiny_http::Server::http("127.0.0.1:8001").map_err(|e| {
                format!("Clipboard server failed to bind 127.0.0.1:8001: {}", e)
            })?;
            eprintln!("Clipboard server listening on 127.0.0.1:8001");

            thread::spawn(move || {
                for mut request in server.incoming_requests() {
                    let cors = tiny_http::Header::from_bytes(
                        &b"Access-Control-Allow-Origin"[..],
                        &b"http://localhost:5174"[..],
                    )
                    .unwrap();

                    let is_post = request.method() == &tiny_http::Method::Post;

                    // Route: POST /clipboard — write text to system clipboard via arboard
                    if is_post && request.url() == "/clipboard" {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            eprintln!("Clipboard request read failed: {}", e);
                            let resp = tiny_http::Response::from_string(format!("Read error: {}", e))
                                .with_status_code(500)
                                .with_header(cors);
                            let _ = request.respond(resp);
                            continue;
                        }

                        match arboard::Clipboard::new() {
                            Ok(mut clipboard) => match clipboard.set_text(&body) {
                                Ok(()) => {
                                    let resp = tiny_http::Response::from_string("")
                                        .with_status_code(204)
                                        .with_header(cors);
                                    let _ = request.respond(resp);
                                }
                                Err(e) => {
                                    eprintln!("Clipboard set_text failed: {}", e);
                                    let resp = tiny_http::Response::from_string(format!(
                                        "Clipboard write failed: {}",
                                        e
                                    ))
                                    .with_status_code(500)
                                    .with_header(cors);
                                    let _ = request.respond(resp);
                                }
                            },
                            Err(e) => {
                                eprintln!("Clipboard init failed: {}", e);
                                let resp = tiny_http::Response::from_string(format!(
                                    "Clipboard init failed: {}",
                                    e
                                ))
                                .with_status_code(500)
                                .with_header(cors);
                                let _ = request.respond(resp);
                            }
                        }
                        continue;
                    }

                    // Route: POST /audio/play — play embedded WAV via rodio
                    // Body is the sound name: "copy" or "clear".
                    // Returns 204 immediately; playback runs in a spawned thread.
                    if is_post && request.url() == "/audio/play" {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            eprintln!("Audio request read failed: {}", e);
                            let resp = tiny_http::Response::from_string(format!("Read error: {}", e))
                                .with_status_code(500)
                                .with_header(cors);
                            let _ = request.respond(resp);
                            continue;
                        }

                        let wav_data: Option<&'static [u8]> = match body.trim() {
                            "copy" => Some(COPY_WAV),
                            "clear" => Some(CLEAR_WAV),
                            _ => None,
                        };

                        match wav_data {
                            Some(data) => {
                                thread::spawn(move || {
                                    if let Err(e) = play_wav(data) {
                                        eprintln!("Audio playback failed: {}", e);
                                    }
                                });
                                let resp = tiny_http::Response::from_string("")
                                    .with_status_code(204)
                                    .with_header(cors);
                                let _ = request.respond(resp);
                            }
                            None => {
                                let resp = tiny_http::Response::from_string("Unknown sound")
                                    .with_status_code(400)
                                    .with_header(cors);
                                let _ = request.respond(resp);
                            }
                        }
                        continue;
                    }

                    // Fallback: 404
                    let resp = tiny_http::Response::from_string("Not Found")
                        .with_status_code(404)
                        .with_header(cors);
                    let _ = request.respond(resp);
                }
            });

            // Spawn sidecar
            let mut child = match spawn_sidecar(&api_dir) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Sidecar spawn failed: {}", e);
                    return Err(e.into());
                }
            };

            // Health poll in a background thread — emit event when ready
            let app_handle = app.handle().clone();
            let health_timeout = Duration::from_secs(120);

            thread::spawn(move || {
                match wait_for_health(&mut child, health_timeout) {
                    Ok(()) => {
                        eprintln!("Sidecar healthy, emitting backend-ready");
                        let _ = app_handle.emit("backend-ready", ());
                    }
                    Err(e) => {
                        eprintln!("Sidecar health check failed: {}", e);
                        // Show error dialog
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.eval(&format!(
                                "alert('Voice Scribe backend failed to start:\\n\\n{}')",
                                e.replace('\'', "\\'")
                            ));
                        }
                        // Kill the sidecar if it's still running
                        kill_sidecar(&mut child);
                        std::process::exit(1);
                    }
                }

                // Store the child handle for shutdown
                let state: tauri::State<Sidecar> = app_handle.state();
                *state.0.lock().unwrap() = Some(child);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let sidecar: tauri::State<Sidecar> = window.app_handle().state();
                let mut guard = sidecar.0.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    eprintln!("Window closing — shutting down sidecar");
                    kill_sidecar(child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
