# Voice Scribe v3 — Progress Report

**Date:** April 8, 2026
**Author:** Johnraymond Yanez
**Status:** v3.0–v3.3 gate-passed. v3.3 complete (2026-04-08). Voice Scribe is feature-complete as a capture primitive.

---

## Current State

The Tauri desktop application launches, spawns the Python API as a sidecar, waits for health, and transitions the UI from "Starting backend..." to an active Record button. Push-to-talk and continuous recording through the desktop webview produce GPU-accelerated transcription at sub-second inference latency (0.8–1.0s on large-v3).

Voice commands produce audible confirmation. Saying "copy" writes the transcript to the system clipboard and plays an ascending chime. Saying "clear" empties the transcript and plays a descending sweep. Audio cues play through the OS audio system in both runtime contexts — browser uses `HTMLAudioElement`, desktop uses a Rust-side `rodio` endpoint on port 8001 (same `tiny_http` server as the clipboard). A mute toggle in Settings silences all cues. Continuous-mode transcript segments join with correct whitespace. All three clipboard call sites route through `platform.writeClipboard()`.

The platform abstraction layer (`platform.ts`) routes clipboard writes, audio playback, and recording state emission by runtime context. In desktop context, clipboard and audio POST to the Rust HTTP server on port 8001, bypassing WebKitGTK entirely. Recording state changes emit to the Rust process for tray tooltip sync. Browser behavior is unchanged. Auto-scroll pins to the bottom in continuous mode.

A system tray provides background access: context menu (Toggle Recording, Settings, Quit), recording-state tooltip, and left-click window toggle. Closing the window minimizes to the taskbar — the sidecar stays alive. A second close from the minimized state quits with sidecar cleanup. Three quit paths guarantee cleanup: tray Quit, second-close, and PID-file fallback.

Global shortcut registration (`tauri-plugin-global-shortcut`) was implemented and removed during v3.3. X11's `XGrabKey` does not deliver events on WSLg's XWayland — registration succeeds but the handler never fires. Separately, WebKitGTK intercepts `Ctrl+Shift+Space` (accessibility activation, alternating dispatch) and `Ctrl+Shift+S` (Save As) at the native level before they reach JavaScript. Browser hotkeys `Ctrl+Shift+Y` (copy) and `Ctrl+Shift+X` (clear) work reliably in the desktop webview. The frontend event bridge for tray and global shortcut events is wired and tested — re-adding the plugin is a Rust-only change when validated on a native Linux desktop.

169 automated tests pass (125 frontend, 44 backend). Rust compiles clean with zero warnings. TypeScript compiles clean.

| Deliverable | Status |
|---|---|
| Phase A — wsCleanupSet refactor | Complete (`8cbc933`) |
| Phase A — Config defaults | Complete (`8cbc933`) |
| Phase B — Tauri scaffolding | Complete |
| Phase B — Sidecar lifecycle | Complete |
| Phase B — CORS for Tauri origin | Complete |
| Phase B — Backend-readiness gate | Complete |
| Phase B — Makefile target | Complete |
| Phase B — WebKitGTK media permissions | Complete (triage fix) |
| Phase B — CUDA runtime for bare host | Complete (triage fix) |
| Bare-host GPU inference | Verified |
| `docs/v3/host-setup.md` | Complete (`69457d0`) |
| v3.1 — `platform.ts` abstraction | Complete |
| v3.1 — Native clipboard (HTTP server + arboard) | Complete |
| v3.1 — Clipboard call site routing | Complete (3 of 3 — final site routed in v3.2) |
| v3.1 — Desktop clipboard routing test | Complete |
| Auto-scroll in continuous mode | Complete |
| v3.1 — WebKitGTK recording fallback (Triage #8) | Complete |
| v3.1 — Backend 0-byte audio guard | Complete |
| v3.1 — Frontend empty-blob guard | Complete |
| Port standardization (8084/5174) for desktop | Complete |
| v3.2 — Audio feedback for `copy` (chime after clipboard success) | Complete |
| v3.2 — Audio feedback for `clear` (sweep on state clear) | Complete |
| v3.2 — Rust-side audio playback (`rodio` on port 8001) | Complete |
| v3.2 — Mute toggle in Settings | Complete |
| v3.2 — Transcript.tsx clipboard routing (3rd call site) | Complete |
| v3.2 — Transcript segmentation fix | Complete |
| v3.3 — System tray (icon, menu, tooltip sync) | Complete |
| v3.3 — Close-to-minimize with second-close quit | Complete |
| v3.3 — Sidecar cleanup on all quit paths | Complete |
| v3.3 — Frontend event bridge (tray, shortcut failure) | Complete |
| v3.3 — Recording state emission (JS→Rust) | Complete |
| v3.3 — Desktop hotkey hints (WebKitGTK-functional only) | Complete |
| v3.3 — Clear hotkey audio cue (`Ctrl+Shift+X`) | Complete |
| v3.3 — WebKitGTK key interceptions documented | Complete |
| v3.3 — Global shortcut registration | Removed (XGrabKey non-functional on WSLg) |

---

## Phase A — Prerequisites (Complete)

Covered in detail in the prior progress report revision. Summary:

- `wsCleanupRef` replaced with `wsCleanupSetRef` (Set pattern with deregister-on-completion). Closes the continuous-mode cleanup gap. Two tests verify multi-segment cleanup and stale-entry deregistration.
- Config defaults changed from Docker-centric paths to host-friendly paths. `compose.dev.yml` overrides preserve Docker behavior.

---

## Phase B — Tauri Desktop Shell (Complete)

### Scaffolding

`apps/desktop/src-tauri/` created with Tauri v2 project structure:

| File | Purpose |
|---|---|
| `Cargo.toml` | Dependencies: tauri 2, tauri-plugin-shell 2, arboard 3, tiny\_http 0.12, reqwest (blocking), webkit2gtk (Linux), libc (Unix) |
| `tauri.conf.json` | devUrl `http://localhost:5173`, CSP allowing API and WebSocket on localhost:8000, `wasm-unsafe-eval` for ONNX VAD runtime (later standardized to ports 5174/8084) |
| `capabilities/default.json` | Tauri v2 capability permissions: shell spawn/kill, events |
| `build.rs` | Standard Tauri build script |
| `src/main.rs` | Sidecar lifecycle, HTTP clipboard server, WebKitGTK media permissions, shutdown handler |
| `icons/icon.png` | 32x32 placeholder |

### Sidecar Lifecycle

`main.rs` implements the full sidecar lifecycle:

**Spawn.** `find_uvicorn()` resolves the Python executable — checks `apps/api/.venv/bin/uvicorn` first, falls back to system PATH. `cuda_ld_library_path()` discovers CUDA runtime libraries installed as pip packages under `site-packages/nvidia/*/lib/` and injects them via `LD_LIBRARY_PATH` on the spawned process. Without this, `ctranslate2` cannot dlopen `libcublas.so.12` on bare-host setups where CUDA toolkit is not system-installed.

**Health poll.** Background thread polls `GET http://127.0.0.1:8000/health` (later standardized to port 8084) every 500ms with a 120-second timeout. On success, emits `backend-ready` Tauri event to the webview. On timeout or sidecar crash, shows an error dialog and exits. Crash detection checks `Child::try_wait()` each poll cycle — a sidecar that exits with non-zero (port conflict) is surfaced immediately, not after the full timeout.

**Shutdown.** `on_window_event` handler sends SIGTERM on `CloseRequested`. Waits up to 5 seconds for graceful exit, then SIGKILL. The `Child` handle is stored in `Mutex<Option<Child>>` as Tauri managed state, accessible from both the health poll thread and the window event handler.

### CORS

`config.py` default `CORS_ORIGINS` now includes `https://tauri.localhost` (Windows/WSL2 Tauri origin) and `tauri://localhost` (Linux Tauri origin). Both `main.py` CORS middleware and `transcribe_ws.py` WebSocket origin check read from the same `settings.cors_origins` property — one default update covers both surfaces.

### Backend-Readiness Gate

`App.tsx` detects Tauri context via `typeof window.__TAURI__ !== "undefined"` at module scope. In browser context, `backendReady` starts `true` — no gate, no behavior change. In Tauri context, `backendReady` starts `false` and a `useEffect` listens for the `backend-ready` event. `Recorder.tsx` shows "Starting backend..." when `!backendReady`. Two new tests cover both contexts (dynamic import with `vi.resetModules()` for the Tauri path).

### Makefile

`make desktop` starts Vite as a background process, writes its PID to `/tmp/voice-scribe-vite.pid`, traps EXIT/INT/TERM, then runs `cargo tauri dev`. `PATH` export at the top of the Makefile includes `~/.cargo/bin` so `cargo` is findable from `/bin/sh`.

---

## v3.1 — Platform Abstraction + Native Clipboard (Complete)

### platform.ts

`apps/web/src/services/platform.ts` is the single routing surface for platform-conditional behavior. Three exports:

| Export | Browser | Tauri |
|---|---|---|
| `isDesktop()` | Returns `false` | Returns `true` (`window.__TAURI__`) |
| `writeClipboard(text)` | `navigator.clipboard.writeText()` | `fetch()` POST to `http://127.0.0.1:8001/clipboard` |
| `submitText(text)` | Calls `writeClipboard()` (stub) | Calls `writeClipboard()` (stub — submit deferred) |

Desktop clipboard writes use `fetch()` POST to a Rust-side HTTP listener (`tiny_http` on port 8001). The Rust process reads the request body and writes to the system clipboard via `arboard`. This bypasses WebKitGTK entirely — the browser's Fetch API has no user-activation requirement for POST requests, so voice commands (which fire from WebSocket callbacks with no user gesture) work. See Triage #6 for why the Tauri clipboard plugin is not used.

### Clipboard Call Site Routing

Two of three clipboard call sites in the frontend now route through `platform.writeClipboard()`:

1. **`App.tsx` — `copy` voice command:** `platform.writeClipboard(transcriptRef.current)`
2. **`App.tsx` — `handleCopyTranscript`:** `platform.writeClipboard(transcript)`

The third call site — the "Copy to Clipboard" button in `Transcript.tsx` — still calls `navigator.clipboard.writeText()` directly. It functions via its `execCommand("copy")` fallback in the Tauri webview, but is inconsistent with the platform layer. Tracked as a v3.2 cleanup item.

### HTTP Clipboard Server

`main.rs` spawns a `tiny_http` listener on `127.0.0.1:8001` during `setup()`. The listener accepts `POST /clipboard` with a plain text body, writes the body to the system clipboard via `arboard::Clipboard::set_text()`, and returns 204. CORS is set to allow `http://localhost:5174` (the Vite dev server origin; originally 5173, standardized to 5174 during port migration). The server thread runs for the lifetime of the Tauri process — no explicit shutdown needed (thread is not joined; OS reclaims on process exit).

The Tauri clipboard plugin (`tauri-plugin-clipboard-manager`) was tested and rejected. See Triage #6.

### Tests

Eight tests in `apps/web/tests/platform.test.ts` cover `isDesktop()` detection in both contexts, `writeClipboard()` browser path, `writeClipboard()` Tauri/HTTP path (fetch mock), `submitText()` delegation, and error handling.

One integration test in `apps/web/tests/App.test.tsx` ("desktop voice command clipboard routing") sets `window.__TAURI__`, re-imports App via `vi.resetModules()`, fires the "copy" voice command through a full VAD cycle, and asserts: (1) `isDesktop()` returns true, (2) `fetch()` was called on `http://127.0.0.1:8001/clipboard`, (3) `navigator.clipboard.writeText` was NOT called. This test would have caught the original `isDesktop()` routing bug directly.

---

## Auto-Scroll in Continuous Mode

Transcript textarea pins to the bottom as new segments arrive during continuous recording. Pin behavior:

- **Engaged** on new recording session start and when user scrolls to bottom
- **Released** on user scroll away from bottom or manual text edit
- **Re-engaged** on scroll-to-bottom or next session start

Five new tests in `apps/web/tests/Transcript.test.tsx` verify pin/release/re-engage behavior.

This was not in the v3.1 roadmap scope — it's a UX improvement that shipped in the same session. Continuous mode without auto-scroll required manual scrolling to see incoming segments, which was a practical friction point during field testing.

---

## v3.2 — Audio Feedback + Clipboard Cleanup + Segmentation Fix (Complete)

Six scope items delivered across `264cc6b` and `aee2787`. Gate passed 2026-04-08.

### Audio Cues

Voice commands produce audible confirmation. Copy: ascending chime after `writeClipboard()` resolves (no sound on failure). Clear: descending sweep on state clear. Cues are distinct without visual context.

Two playback paths selected at runtime via `isDesktop()` in `audio.ts`:

| Context | Path | Mechanism |
|---|---|---|
| Browser | `HTMLAudioElement` with preloaded WAV files (`/sounds/copy.wav`, `/sounds/clear.wav`) | Standard browser audio |
| Desktop (Tauri) | POST to `http://127.0.0.1:8001/audio/play` → Rust `rodio` playback | `include_bytes!` WAV embedding, fire-and-forget thread with `Sink::sleep_until_end()`, 204 response |

**Scope expansion.** The v3.2 scope said "Web Audio API or bundled audio files... no new dependencies beyond the sound assets themselves." WebKitGTK's audio subsystem proved unreliable in the Tauri webview — three failure modes: (1) devtools interaction kills audio output, (2) Bluetooth device switching loses the audio path, (3) codec ramp-up truncates short transients. `rodio` added as a Rust dependency. Same WebKitGTK bypass pattern as the v3.1 clipboard server — two OS-level operations now route through the Rust HTTP server on port 8001. This was the pre-identified fallback path in the implementation plan.

### Mute Toggle

Settings panel toggle silences all audio cues. `localStorage` persistence (same pattern as recording mode toggle). Module-scoped state in `audio.ts` — `setAudioMuted()` / `isAudioMuted()`.

### Clipboard Routing Consolidation

The `Transcript.tsx` "Copy to Clipboard" button now routes through `platform.writeClipboard()`. All three clipboard call sites use the platform layer:

1. `App.tsx` — `copy` voice command
2. `App.tsx` — `handleCopyTranscript`
3. `Transcript.tsx` — "Copy to Clipboard" button

Completes the v3.1 backlog item (previously 2 of 3).

### Transcript Segmentation Fix

Continuous-mode segment joins produce correct whitespace: space on short pause, paragraph break on long pause, no prefix on first segment. Root cause: `clean_transcript` in `cleanup.py` calls `.strip()`, so every `result.cleaned` is trimmed on both ends. The separator logic in `App.tsx` produced `""` when below `PARAGRAPH_BREAK_MS` — two consecutive segments concatenated with no space at the join.

### Gate-Time Fix

The `Transcript.tsx` copy button was missing the audio chime — `writeClipboard()` was routed correctly through the platform layer, but `playCopySound()` was never wired. One import, one line. The chime is fire-and-forget (not `await`) — audio playback failure must not block the "Copied!" visual feedback.

### New Artifacts

| File | Purpose |
|---|---|
| `apps/web/src/services/audio.ts` | Audio cue playback — platform branching, mute state, preload |
| `apps/web/public/sounds/copy.wav` | Ascending chime |
| `apps/web/public/sounds/clear.wav` | Descending sweep |
| `ops/scripts/generate_sounds.py` | Deterministic WAV asset generation |

---

## v3.3 — System Tray + Window Management (Complete)

Eight deliverables across `20cc2d6`. Gate passed 2026-04-08.

### System Tray

Tauri v2 tray (part of core, no plugin crate). Icon uses the existing `apps/desktop/src-tauri/icons/icon.png`. Three context menu items: Toggle Recording, Settings (shows window before emitting event), Quit (sidecar cleanup via `app_handle.state::<Sidecar>()` → `kill_sidecar()` → `exit(0)`). Left-click on the tray icon toggles window visibility. Tooltip reflects recording state: Idle, Listening, Recording, Processing.

On WSLg, the tray icon does not render — WSLg's compositor lacks SNI/XEmbed tray panel support. The code is correct for native Linux desktop environments (GNOME, KDE) that provide a tray.

### Window Management

Close-to-minimize: `CloseRequested` is intercepted. First close minimizes to the taskbar — the sidecar stays alive and the window remains accessible. Second close from the minimized state runs sidecar cleanup and exits. `WindowEvent::Focused(true)` resets the minimized flag so restoring the window re-enables the first-close-minimizes behavior.

Minimize (not hide) is intentional: WSLg does not render the system tray and XGrabKey-based global shortcuts do not fire, so a hidden window would be inaccessible. On native Linux with a working tray and global hotkey, switching to `window.hide()` is the right behavior (documented as a TODO in `main.rs`).

Three quit paths guarantee sidecar cleanup:
1. **Tray Quit** — menu handler takes `Sidecar` state, calls `kill_sidecar()`
2. **Second-close** — `CloseRequested` handler detects `Minimized` state, runs same cleanup
3. **PID-file fallback** — `/tmp/voice-scribe-sidecar.pid` written at spawn, Makefile trap reads it on `SIGINT`

### Frontend Event Bridge

`App.tsx` registers three Tauri event listeners in desktop mode:
- `tray-toggle-recording` → `handleToggleRecording()` (same handler as UI button and keyboard shortcut)
- `tray-toggle-settings` → `handleToggleSettings()`
- `shortcut-registration-failed` → surfaces the error message in the UI

All three use the existing `__TAURI__?.event?.listen` pattern established by the `backend-ready` listener. The tray menu, UI button, and `useHotkeys` all route through the same `handleToggleRecording` / `handleToggleSettings` callbacks — single code path, consistent state guards.

### Recording State Emission

`setState()` in `App.tsx` wraps `setStateRaw()` and calls `emitRecordingState()` on every transition. `emitRecordingState()` in `platform.ts` emits `recording-state-changed` to the Rust process in desktop mode (no-op in browser). The Rust side listens for this event and updates the tray tooltip via `tray_handle.set_tooltip()`.

### Global Shortcut — Implemented and Removed

`tauri-plugin-global-shortcut` was added, wired, and tested during v3.3 implementation. Three failures discovered in sequence:

1. **XGrabKey does not deliver events on WSLg.** Registration succeeds (`"Global shortcut registered: Ctrl+Shift+Space"` in stderr), but the handler callback never fires. WSLg's XWayland does not deliver grabbed key events — this is a compositor limitation, not a key conflict.

2. **WebKitGTK intercepts `Ctrl+Shift+Space` independently of the plugin.** Accessibility activation key. Alternating dispatch: first press swallowed, second press delivered, third swallowed. This is intrinsic WebKitGTK behavior — confirmed by removing the plugin entirely and observing the same pattern.

3. **WebKitGTK intercepts `Ctrl+Shift+S`.** Save As browser shortcut. Never reaches the JavaScript `keydown` handler.

`Ctrl+Shift+Y` and `Ctrl+Shift+X` are unaffected — no WebKitGTK built-in binding claims them. Desktop hotkey hints in `App.tsx` show only these two. WebKitGTK interceptions are documented in `useHotkeys.ts`.

**Decision:** Plugin removed from `Cargo.toml`, `capabilities/default.json`, and `main.rs`. The frontend event bridge (`shortcut-registration-failed` listener, `tray-toggle-recording` handler) is retained — re-adding the plugin on native Linux is a Rust-only change. When re-added, the shortcut handler should fire regardless of window focus (no `is_focused()` gate); the 200ms debounce in `handleToggleRecording` absorbs any double-fire with `useHotkeys`.

### Debounce

`handleToggleRecording` includes a 200ms debounce via `lastToggleRef`. Absorbs rapid-fire from tray menu clicks, key repeat, or the eventual global shortcut re-addition where both the Rust handler and `useHotkeys` could fire for the same keypress. Test verifies a `useHotkeys` + `tray-toggle-recording` pair in the same tick results in one `startListening` call.

### New Artifacts

| File | Change |
|---|---|
| `apps/desktop/src-tauri/src/main.rs` | Tray setup, state sync listener, close-to-minimize with second-close quit, `Minimized` managed state |
| `apps/desktop/src-tauri/Cargo.toml` | `tray-icon` feature added to tauri dependency |
| `apps/desktop/src-tauri/capabilities/default.json` | Global-shortcut permissions removed (plugin stripped) |
| `apps/web/src/app/App.tsx` | Tray/shortcut event listeners, `setState` wrapper with `emitRecordingState`, debounce, desktop hotkey hints |
| `apps/web/src/services/platform.ts` | `emitRecordingState()` export |
| `apps/web/src/hooks/useHotkeys.ts` | WebKitGTK interception documentation |
| `apps/web/tests/App.test.tsx` | +6 tests: tray events, state emission, shortcut failure, rapid-fire, debounce |
| `apps/web/tests/platform.test.ts` | +3 tests: `emitRecordingState` desktop/browser/missing-event paths |

---

## Triage — Issues Encountered During Bring-Up

Five issues surfaced during the first successful `make desktop` runs. Each was encountered in sequence, diagnosed, and resolved before the next became visible.

### 1. API directory resolution panic

**Symptom:** `thread 'main' panicked at ... API directory not found`
**Cause:** `app.path().resource_dir()` in dev mode resolves to `src-tauri/target/debug/`, not the repo root. The relative path `../../../api` from there lands at `apps/desktop/api` — one level short.
**Fix:** Use `CARGO_MANIFEST_DIR` (compile-time constant, always `apps/desktop/src-tauri`) as the primary path. `../../api` from there correctly resolves to `apps/api`. The `resource_dir()` approach is deferred to production bundling (post-v3.0).

### 2. `libcublas.so.12` not found on bare host

**Symptom:** `ws inference failed: Library libcublas.so.12 is not found or cannot be loaded`
**Cause:** `ctranslate2` dlopens `libcublas.so.12` at inference time. In Docker mode, the NVIDIA container runtime provides CUDA libraries. On bare host (WSL2), the GPU driver is present (`nvidia-smi` works, `ctranslate2.get_cuda_device_count() == 1`), but the CUDA toolkit runtime libraries are not system-installed.
**Analysis:** `strings` on `libctranslate2` confirmed exactly two dlopen targets: `libcuda.so.1` (present via WSL driver passthrough) and `libcublas.so.12` (missing). No cuDNN dependency.
**Fix:** Two parts. (1) `pip install nvidia-cublas-cu12` — provides `libcublas.so.12` and `libcublasLt.so.12` under `site-packages/nvidia/cublas/lib/`. (2) `cuda_ld_library_path()` in `main.rs` — discovers these lib directories at sidecar spawn time by querying `site.getusersitepackages()`, scanning `nvidia/*/lib/`, and injecting the result as `LD_LIBRARY_PATH` on the child process.

### 3. Orphaned Vite processes on crash

**Symptom:** Port 5173 and 5174 occupied by stale `node` processes after a panic or Ctrl+C during development.
**Cause:** The original Makefile `desktop` target used `&` backgrounding with a PID variable. If `cargo tauri dev` panicked, the shell trap didn't fire and Vite leaked.
**Fix:** PID written to `/tmp/voice-scribe-vite.pid`. Trap registered on EXIT, INT, and TERM signals. Explicit `cleanup` function called both via trap and after `cargo tauri dev` returns normally.

### 4. `getUserMedia` denied by WebKitGTK

**Symptom:** `"The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission."` Recording fails in the desktop webview. Works in the browser.
**Root cause:** WebKitGTK has a two-layer permission model for `getUserMedia`. Layer 1 is a feature gate (`WebKitSettings::enable-media-stream`). Layer 2 is a runtime permission grant via the `permission-request` signal — if no handler is connected, the default behavior is **deny**. The initial fix set `enable-media-stream` to true (layer 1) but did not handle the signal (layer 2). Chromium auto-prompts the user; WebKitGTK delegates to the application.
**Fix:** `connect_permission_request` on the WebKitGTK `WebView` object, auto-granting all permission requests. Safe for a local-first tool with no untrusted content. Dependency: `webkit2gtk = "2.0"` in `Cargo.toml`.

### 5. Chrome-specific error message in `useRecorder.ts`

**Symptom:** The codec-unsupported error message reads "Please use Chrome." — incorrect in desktop context where the user has no browser choice.
**Fix:** Updated to `"Your environment does not support audio/webm;codecs=opus recording."` Context-neutral, accurate in both browser and Tauri webview.

### 6. Tauri clipboard plugin crashes WebKitGTK without user activation

**Symptom:** Saying "copy" after dictation crashes the Tauri desktop app. Terminal shows `VM 0x... on pid ... received NeedDebuggerBreak trap`. The webview process is killed — not a JS error, a hard trap.
**Cause:** The Tauri clipboard plugin (`tauri-plugin-clipboard-manager`) calls through WebKitGTK's IPC mechanism (`window.webkit.messageHandlers`), which requires user activation. Voice commands fire from WebSocket callbacks — no user gesture — so the IPC call triggers a `NeedDebuggerBreak` trap in the WebKitGTK renderer process.
**Investigation sequence:** The original clipboard failure (v3.1 initial implementation) was traced to `isDesktop()` returning false because `withGlobalTauri: true` was missing from `tauri.conf.json`. An HTTP server bypass (`tiny_http` on 8001 + `arboard`) was built as a workaround. Once `withGlobalTauri` was fixed, the plugin was restored alongside the HTTP server to test whether the plugin worked with correct routing. It does not — the crash is the definitive result.
**Fix:** HTTP clipboard server is the permanent architecture. `writeClipboard()` uses `fetch()` POST to `127.0.0.1:8001/clipboard` in desktop context. The Rust process writes to the system clipboard via `arboard`, bypassing WebKitGTK entirely. The plugin package (`@tauri-apps/plugin-clipboard-manager`) and its Rust counterpart (`tauri-plugin-clipboard-manager`) are removed from all dependency and capability files.
**CSP requirement:** `tauri.conf.json` CSP `connect-src` must include `http://127.0.0.1:8001` for the `fetch()` call to succeed in the Tauri webview. This entry was reverted during unrelated debugging and restored at the v3.1 gate (2026-04-05).

### 7. WSL2 audio device loss after WebKitGTK crash

**Symptom:** After the clipboard plugin crash (Triage #6), clicking Record freezes the app. WebKitGTK console shows `OverconstrainedError: "Invalid constraint"` and `"Audio capture was requested but no device was found amongst 0 devices"`.
**Cause:** WSL2 audio passthrough depends on WSLg's PipeWire/PulseAudio session. The WebKitGTK crash orphaned the audio pipeline. `arecord -l` shows no soundcards, `/proc/asound/` does not exist, and ALSA kernel modules are not loaded. PipeWire runs but sees only `Dummy-Driver` — it is not connected to WSLg's PulseAudio server despite `PULSE_SERVER=unix:/mnt/wslg/PulseServer` being set and the socket existing.
**Fix:** `wsl --shutdown` from PowerShell on the Windows side restarts WSLg and re-initializes the audio device passthrough. This is the standard recovery for WSL2 audio loss.
**Impact on gate:** Blocks all manual gate validation (recording requires a microphone). Not a code issue — environment-only. All automated tests pass without audio hardware.

### 8. Push-to-talk recording produces empty audio on WebKitGTK

**Symptom:** Push-to-talk recording in the Tauri desktop app produced silence — the backend received 0 bytes of audio and crashed with an ffmpeg error. The web app (browser) was unaffected. Continuous mode in the desktop app was also unaffected.
**Root cause:** WebKitGTK delegates audio encoding to GStreamer. The installed GStreamer version didn't match what WebKitGTK expected — a missing API (`automatic-eos` on `GstAppSrc`) prevented the encoding pipeline from initializing. `getUserMedia` succeeded (mic access was fine), but `MediaRecorder` silently produced zero bytes because it had no working encoder. This is not WSL2-specific — it would affect any Linux deployment with stale or misconfigured GStreamer packages.
**Why continuous mode wasn't affected:** VAD/continuous recording captures raw PCM samples via `AudioWorklet` and encodes to WAV in JavaScript. It never touches `MediaRecorder` or GStreamer.
**Fix:** Three layers.
1. **Backend guard.** `transcribe_ws.py` rejects 0-byte audio with `{"type": "error", "detail": "No audio data received."}` instead of passing empty data to ffmpeg. New `audio_format` query parameter tells the server which container the client used (e.g., `audio/ogg`); temp file suffix selection uses a `_MIME_TO_SUFFIX` map. ffmpeg probes magic bytes regardless, but the correct suffix improves log clarity.
2. **Frontend guard.** `api.ts` catches empty blobs before sending on both the WebSocket (`streamTranscribeAudio`) and HTTP (`transcribeAudio`) paths. Clear error message: "No audio data was captured. Recording may not be supported in this environment."
3. **Recording fallback.** `useRecorder.ts` now negotiates the MIME type from a prioritized list (`audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/webm`, `audio/ogg`) via `negotiateMimeType()`. When the result is `null` (no supported format — the GStreamer failure case), the hook falls back to `ScriptProcessorNode` raw PCM capture → `encodeWav()` → WAV blob. This is the same `encodeWav()` function continuous mode already uses. The hook's external interface is unchanged; downstream code does not know which capture path ran.
**Impact:** Push-to-talk works on the desktop shell regardless of GStreamer state. The fix is resilient to the entire class of GStreamer-version mismatches on Linux. The `NeedDebuggerBreak` trap and `GstAppSrc automatic-eos` warning (Runtime Warnings #2 and #3) were symptoms of the same root cause — both are now explained.
**Scope:** v3.1 completion item. Push-to-talk on the desktop shell was a v3.1 deliverable that wasn't working on the target platform.
**Tests added:** 7 frontend (4 MIME negotiation, 3 PCM fallback lifecycle) in `useRecorder.test.ts`. 3 backend (audio_format suffix ×2, empty payload rejection) in `test_transcribe_ws.py`.

---

## Runtime Warnings (Non-Blocking)

Three WebKitGTK warnings or traps observed during desktop operation. One (D-Bus) is cosmetic. The other two were symptoms of the GStreamer version mismatch diagnosed in Triage #8 — the recording fallback resolves their functional impact.

| Warning | Cause | Impact |
|---|---|---|
| `Unable to connect to D-Bus session bus` | WSL2 does not provide a D-Bus session bus by default | None — WebKitGTK falls back gracefully |
| `g_object_set_is_valid_property: object class 'GstAppSrc' has no property named 'automatic-eos'` | GStreamer version mismatch — the installed GStreamer lacks the `automatic-eos` API that WebKitGTK expects. Root cause of Triage #8 (empty `MediaRecorder` output) | **Resolved** — `useRecorder.ts` PCM fallback bypasses GStreamer entirely when `MediaRecorder` has no working encoder |
| `VM 0x... received NeedDebuggerBreak trap` | GStreamer `automatic-eos` property mismatch surfacing as a transient media pipeline fault (same root cause as above). Originally two candidate causes; Triage #8 diagnosis confirms GStreamer, not Tauri IPC | **Resolved** — same fallback path. No recurrence expected when `MediaRecorder` is bypassed |

---

## Test State

| Suite | Count | Status |
|---|---|---|
| Frontend (vitest) | 125 | All pass |
| Backend (pytest) | 44 | All pass |
| Rust (cargo check) | — | Clean, zero warnings |
| TypeScript (tsc --noEmit) | — | Clean |
| **Total** | **169** | **Green** |

New tests by phase:

| Phase | Test | File | Verifies |
|---|---|---|---|
| v3.0 | Browser context: Record button enabled on mount | `App.test.tsx` | `backendReady` defaults true when `__TAURI__` absent |
| v3.0 | Tauri context: disabled until backend-ready event | `App.test.tsx` | `backendReady` starts false, transitions to true on event |
| v3.1 | `isDesktop()` detection (×2) | `platform.test.ts` | Returns correct value based on `__TAURI__` presence |
| v3.1 | `writeClipboard()` browser path | `platform.test.ts` | Delegates to `navigator.clipboard.writeText()` |
| v3.1 | `writeClipboard()` Tauri path | `platform.test.ts` | POSTs to HTTP clipboard server, `navigator.clipboard` not called |
| v3.1 | `writeClipboard()` error handling | `platform.test.ts` | Throws on non-OK response from clipboard server |
| v3.1 | `submitText()` delegation | `platform.test.ts` | Calls `writeClipboard()` (stub behavior) |
| v3.1 | Error handling | `platform.test.ts` | Graceful failure on clipboard API rejection |
| v3.1 | Desktop voice command clipboard routing | `App.test.tsx` | `__TAURI__` set, "copy" routes through HTTP server, not `navigator.clipboard` |
| v3.1 | Auto-scroll pin/release/re-engage (×5) | `Transcript.test.tsx` | Scroll behavior in continuous mode |
| v3.1 | `negotiateMimeType()` — prefers webm/opus | `useRecorder.test.ts` | Returns first supported format from priority list |
| v3.1 | `negotiateMimeType()` — ogg fallback | `useRecorder.test.ts` | Falls back to ogg when webm unsupported |
| v3.1 | `negotiateMimeType()` — bare ogg | `useRecorder.test.ts` | Returns bare ogg when only that is supported |
| v3.1 | `negotiateMimeType()` — null when none | `useRecorder.test.ts` | Returns null when no format supported (triggers PCM fallback) |
| v3.1 | ScriptProcessorNode fallback activates | `useRecorder.test.ts` | Creates AudioContext + ScriptProcessor when MIME negotiation returns null |
| v3.1 | PCM fallback produces WAV blob | `useRecorder.test.ts` | Accumulated samples → `encodeWav()` → correct WAV size and type |
| v3.1 | PCM fallback cleanup | `useRecorder.test.ts` | AudioContext closed, ScriptProcessor disconnected, stream tracks stopped |
| v3.1 | `audio_format` → .ogg suffix | `test_transcribe_ws.py` | Server uses correct temp file extension for ogg audio |
| v3.1 | Unknown format → no extension | `test_transcribe_ws.py` | Server omits extension for unrecognized format, lets ffmpeg probe |
| v3.1 | 0-byte audio rejected | `test_transcribe_ws.py` | Server returns error JSON instead of crashing ffmpeg |
| v3.2 | `initAudio` creates both Audio elements | `audioService.test.ts` | Preload creates copy + clear elements |
| v3.2 | `initAudio` sets preload to auto | `audioService.test.ts` | Elements configured for eager loading |
| v3.2 | `playCopySound` calls play() | `audioService.test.ts` | Browser-path copy playback |
| v3.2 | `playCopySound` resets currentTime | `audioService.test.ts` | Rapid repeats don't skip |
| v3.2 | `playCopySound` no-op when not initialized | `audioService.test.ts` | Graceful degradation |
| v3.2 | `playCopySound` skips when muted | `audioService.test.ts` | Mute gates playback |
| v3.2 | `playClearSound` calls play() | `audioService.test.ts` | Browser-path clear playback |
| v3.2 | `playClearSound` skips when muted | `audioService.test.ts` | Mute gates playback |
| v3.2 | Mute default state | `audioService.test.ts` | Defaults to not muted |
| v3.2 | `setAudioMuted(true)` | `audioService.test.ts` | Enables mute |
| v3.2 | `setAudioMuted(false)` | `audioService.test.ts` | Disables mute |
| v3.2 | Desktop: copy posts to audio server | `audioService.test.ts` | Tauri-path fetch to rodio endpoint |
| v3.2 | Desktop: clear posts to audio server | `audioService.test.ts` | Tauri-path fetch to rodio endpoint |
| v3.2 | Desktop: muted skips fetch | `audioService.test.ts` | No server call when muted |
| v3.2 | Desktop: throws on non-OK response | `audioService.test.ts` | Error surfaces from rodio endpoint |
| v3.2 | Copy command plays chime | `App.test.tsx` | Chime fires after clipboard write |
| v3.2 | Copy command: no chime on clipboard failure | `App.test.tsx` | Silence on `writeClipboard()` rejection |
| v3.2 | Clear command plays sweep | `App.test.tsx` | Sweep fires on state clear |
| v3.2 | First segment: no prefix | `App.test.tsx` | Segmentation — initial segment appears as-is |
| v3.2 | Short-gap segments: space separator | `App.test.tsx` | Segmentation — space between quick segments |
| v3.2 | Long-gap segments: paragraph break | `App.test.tsx` | Segmentation — line break on long pause |
| v3.2 | Mute toggle renders unchecked | `Settings.test.tsx` | Default UI state |
| v3.2 | Mute toggle → onAudioMutedChange(true) | `Settings.test.tsx` | Check fires callback |
| v3.2 | Mute toggle → onAudioMutedChange(false) | `Settings.test.tsx` | Uncheck fires callback |
| v3.2 | Transcript button → `platform.writeClipboard()` | `Transcript.test.tsx` | Platform-routed clipboard write |
| v3.2 | Transcript button → "Copied!" feedback | `Transcript.test.tsx` | Visual feedback after write |
| v3.2 | Transcript button → handles failure | `Transcript.test.tsx` | Graceful degradation on clipboard error |
| v3.3 | Tray toggle starts recording when idle | `App.test.tsx` | `tray-toggle-recording` event → `startListening()` called |
| v3.3 | Tray toggle no-op when settings open | `App.test.tsx` | `handleToggleRecording` guard prevents state change |
| v3.3 | Shortcut failure surfaces error | `App.test.tsx` | `shortcut-registration-failed` payload displayed in UI |
| v3.3 | State emission calls `__TAURI__.event.emit` | `App.test.tsx` | `recording-state-changed` emitted on state transition |
| v3.3 | Rapid tray toggle — no state corruption | `App.test.tsx` | Two events in same tick, debounce absorbs second |
| v3.3 | `Ctrl+Shift+Space` works in desktop via `useHotkeys` | `App.test.tsx` | Browser hotkey fires `startListening()` in Tauri context |
| v3.3 | Double-fire debounce (hotkey + tray) | `App.test.tsx` | `startListening` called once, not twice |
| v3.3 | `emitRecordingState` — browser no-op | `platform.test.ts` | No throw, no emit when `__TAURI__` absent |
| v3.3 | `emitRecordingState` — desktop emits | `platform.test.ts` | Calls `__TAURI__.event.emit` with state string |
| v3.3 | `emitRecordingState` — missing event no-op | `platform.test.ts` | No throw when `__TAURI__` exists but `event` is undefined |

---

## Gate Validation — Complete

v3.0 and v3.1 gates passed 2026-04-05. v3.2 and v3.3 gates passed 2026-04-08.

**v3.0 gate (roadmap line 732–734):** App launched, sidecar started and passed health check, continuous-mode recording worked through Tauri webview, model loaded (large-v3, CUDA) with sub-second inference latency (0.4–1.0s). Voice commands and settings panel exercised during v3.1 gate session.

**v3.1 gate (roadmap line 771–774):**
1. Dictate → say "copy" → paste in Discord → transcript appeared ✓
2. Dictate → Ctrl+Shift+Y → paste in Discord → transcript appeared ✓
3. Browser build: `npm run build` zero errors, `npx vitest run` 84/84, `tsc --noEmit` clean, clipboard works in Chrome via Ctrl+Shift+Y ✓

**Fix applied at gate:** `tauri.conf.json` CSP `connect-src` was missing `http://127.0.0.1:8001` (clipboard server origin). Entry had been added in a prior session, reverted during unrelated debugging, never restored. One-line fix, no other code changes.

**v3.2 gate (roadmap lines 872–879):**
1. Dictate → say "copy" → chime plays → switch app → Ctrl+V → transcript is there ✓
2. Dictate → say "clear" → sweep plays → textarea is empty ✓
3. Silence test: clipboard server not running → "copy" → no chime ✓
4. Mute toggle: enable mute → copy and clear → no sounds play ✓
5. All three clipboard call sites through `platform.writeClipboard()` ✓
6. Segmentation: continuous dictation with varied pause lengths — correct whitespace ✓
7. Browser build: `npm run build` zero errors, `npx vitest run` 115/115 ✓

**Gate-time fix:** `Transcript.tsx` copy button missing `playCopySound()` call. One import, one line. Chime wired as fire-and-forget — audio failure does not block "Copied!" feedback.

**v3.3 gate (roadmap lines 922–925):**

The roadmap gate scenario — hide to tray, focus VS Code, press global hotkey, dictate, say "copy", paste — requires a native Linux desktop. The global hotkey component (XGrabKey) does not function on WSLg. Gate verification was split into component-level and end-to-end:

*Component-level (verified on WSLg):*
1. Tray menu Toggle Recording → `handleToggleRecording()` fires, recording starts ✓
2. Tray menu Settings → window shows, settings panel opens ✓
3. Tray menu Quit → sidecar killed (PID file removed, no orphaned Python process) ✓
4. Close window → minimizes to taskbar, sidecar stays alive ✓
5. Second close from minimized → sidecar cleanup, app exits ✓
6. Recording state emission → tray tooltip updates on state change ✓
7. Shortcut registration failure → error message surfaces in UI ✓
8. `Ctrl+Shift+Y` (copy) and `Ctrl+Shift+X` (clear) → fire reliably in desktop webview ✓
9. Rapid-fire toggle (two events in same tick) → debounce absorbs second, no state corruption ✓
10. `npx vitest run` 125/125, `npx tsc --noEmit` clean, `cargo check` clean ✓

*End-to-end (deferred to native Linux):*
- Global hotkey fires from unfocused application
- Tray icon renders in system tray panel
- Full gate scenario: hide → hotkey → dictate → copy → paste → window never appeared

**Scope reduction documented:** Global shortcut plugin removed after investigation confirmed XGrabKey is non-functional on WSLg. The feature is architecturally supported (event bridge wired and tested) but not present in the build. Re-addition is a Rust-only change.

---

## Reviewer Notes

### For PM

**v3.0 scope held.** Phase B delivered the five planned deliverables plus two triage fixes that were direct consequences of the bare-host transition (CUDA runtime, WebKitGTK permissions). No scope additions — both fixes address runtime requirements that were always implicit in "desktop app records audio with GPU inference" but only became visible at integration time. The `useRecorder.ts` error message update was flagged by the Principal during triage review. `docs/v3/host-setup.md` delivered at `69457d0`.

**v3.1 scope held.** Three of four roadmap scope items delivered: platform abstraction layer, native clipboard (HTTP server, not plugin — see Triage #6), and clipboard call site routing. `voiceCommands.ts` unchanged per plan — `submit` deferred indefinitely from Voice Scribe. One call site (`Transcript.tsx` "Copy to Clipboard" button) was deferred to v3.2 cleanup and is now routed.

**v3.2 scope held.** Six scope items delivered. Scope item 3 (audio implementation) expanded — `rodio` added as a Rust dependency after WebKitGTK audio proved unreliable. Same bypass pattern as v3.1 clipboard server. Pre-identified fallback path. No speculative features entered: "scribble" sound and per-cue toggle configuration proposed during implementation and rejected as scope creep. All three clipboard call sites now route through `platform.writeClipboard()`. Segmentation fix verified with continuous dictation.

**WebKitGTK recording fix (2026-04-07).** Push-to-talk on the desktop shell — a v3.1 deliverable — was not functional at gate time. `MediaRecorder` silently produced 0-byte audio due to a GStreamer encoding pipeline failure. Three-layer fix: backend 0-byte rejection, frontend empty-blob guard, and `ScriptProcessorNode` PCM fallback in `useRecorder.ts`. The fallback reuses the `encodeWav()` path that continuous mode already exercises. 10 new tests (7 frontend, 3 backend). This is a v3.1 completion item, not new v3.2 work.

**Auto-scroll** was not in v3.1 roadmap scope. It shipped in the same session as a UX improvement discovered during field testing — continuous mode without it required manual scrolling to track incoming segments. Scope expansion is small (one behavior, five tests) and does not affect any other milestone.

**v3.3 scope reduced.** Four roadmap items; three delivered, one removed. System tray, window management, and full-loop verification (component-level) are complete. Global shortcut registration was implemented, investigated on WSLg, and removed after confirming XGrabKey does not deliver events under WSLg's XWayland. This is a platform limitation — the code was correct, the environment does not support the mechanism. The frontend event bridge is wired and tested; re-addition on native Linux is a Rust-only change. The roadmap's conditional hard requirement for configurable bindings did not trigger — the failure is architectural (XGrabKey non-functional), not a key conflict that configurability would solve.

**WebKitGTK keyboard interceptions (discovered during v3.3).** `Ctrl+Shift+Space` and `Ctrl+Shift+S` are intercepted by WebKitGTK at the native level and do not reliably reach JavaScript in the Tauri webview. These are pre-existing platform constraints, not v3.3 regressions — they were not previously noticed because desktop keyboard shortcuts were not exercised until v3.3 investigation. `Ctrl+Shift+Y` (copy) and `Ctrl+Shift+X` (clear) work reliably. Desktop hotkey hints show only the functional bindings. Recording in desktop mode uses the UI button or tray menu.

**v3.3 is the last mainline milestone.** Voice Scribe is feature-complete as a capture primitive. Two runtime contexts (browser, desktop), GPU-accelerated local transcription, voice commands with audio feedback, system tray with background operation. Further capability expansion belongs to downstream products — see Adjacent Projects in the roadmap.

### For Principal

**WebKitGTK permission model.** The two-layer pattern (feature gate + signal handler) is documented in WebKitGTK's API but not surfaced by Tauri's abstraction layer. The failure mode was silent denial — `getUserMedia` rejected with `NotAllowedError`, no prompt, no WebKitGTK-level error. `set_enable_media_stream(true)` alone was the incomplete fix that initially appeared correct because it compiled and the feature gate error message changed. The signal handler (`connect_permission_request`) was the missing layer.

**CUDA runtime discovery.** `cuda_ld_library_path()` scans two locations at sidecar spawn time: (1) venv site-packages via `getsitepackages()` using the venv's Python, then (2) user-scope site-packages via `getusersitepackages()` using system Python. Both paths scan `nvidia/*/lib/` directories and append any found libraries. Existing `LD_LIBRARY_PATH` is preserved and appended. The function does not modify the parent process environment. This covers both `pip install nvidia-cublas-cu12` (venv) and `pip install --user nvidia-cublas-cu12` (user scope).

**`resource_dir()` vs `CARGO_MANIFEST_DIR`.** The API directory resolution was simplified to `CARGO_MANIFEST_DIR` only. `resource_dir()` is the correct approach for production bundles but returned `target/debug/` in dev mode, producing a wrong relative path. Mixing both in an `or_else` chain masked the dev-mode failure because `resource_dir()` succeeded (returned a path) but the path was wrong. The compile-time constant is correct for all dev builds and makes the failure mode obvious if the directory doesn't exist (panic with path in message). Production bundling is post-v3.0. `CARGO_MANIFEST_DIR` bakes the build machine's absolute path into the binary — the moment distribution packaging produces a `.deb` or `.msi`, the API directory resolution must switch to `resource_dir()` or `app.path().resolve()`.

**Outstanding non-blocking items.** D-Bus warning in WSL2 is cosmetic. The GStreamer `automatic-eos` and `NeedDebuggerBreak` warnings are now explained — both are symptoms of the GStreamer version mismatch diagnosed in Triage #8. The recording fallback bypasses GStreamer entirely, so the warnings have no functional impact. All three clipboard call sites now route through `platform.writeClipboard()` (the `Transcript.tsx` button was the last, routed in v3.2). WebSocket smoke test gap from v2 delivery report remains open.

**Clipboard plugin crash.** The Tauri clipboard plugin (`tauri-plugin-clipboard-manager`) was the original v3.1 plan. It crashes WebKitGTK with a `NeedDebuggerBreak` trap when called from a WebSocket callback (no user activation). This was confirmed by restoring the plugin with correct `isDesktop()` routing (`withGlobalTauri: true` verified) and observing the crash on a "copy" voice command. The HTTP server bypass (Triage #6) is the permanent architecture. The plugin should not be retested — this is a closed decision.

**WSL2 audio loss.** The plugin crash (Triage #6) orphaned the WSL2 audio pipeline. `arecord -l` sees no soundcards, PipeWire sees only Dummy-Driver. Fix is `wsl --shutdown` from PowerShell. This blocks manual gate validation but is environment-only — all 169 automated tests pass without audio hardware.

**Triage as operational reference.** `docs/v3/host-setup.md` should include a troubleshooting section referencing triage items #2 (CUDA runtime — `libcublas.so.12` not found, resolved by `nvidia-cublas-cu12` pip package + `cuda_ld_library_path()` injection), #4 (WebKitGTK permissions — silent `getUserMedia` denial, resolved by `enable-media-stream` feature gate + `connect_permission_request` signal handler), #6 (clipboard plugin crash — resolved by HTTP server on 8001), and #8 (GStreamer recording failure — resolved by `ScriptProcessorNode` PCM fallback). These are the exact problems someone will hit on a new machine.

**v3.3 — global shortcut investigation.** Three distinct failures, discovered in sequence: (1) XGrabKey registers but never delivers events on WSLg's XWayland. (2) With the plugin loaded, WebKitGTK exhibits a `NeedDebuggerBreak` trap on `Ctrl+Shift+Space` — first press swallowed, second delivered, alternating. (3) With the plugin removed entirely, the alternating pattern persists for `Ctrl+Shift+Space` — this is intrinsic WebKitGTK behavior (accessibility activation key), not a plugin side effect. The comment in `main.rs` documents all three findings and the re-addition path. The `is_focused()` gate from the original plan should not be used when re-adding — the global shortcut should fire unconditionally, with the 200ms debounce in `handleToggleRecording` absorbing any double-fire with `useHotkeys`.

**v3.3 — `useHotkeys` kept active in desktop mode.** The implementation plan specified disabling `useHotkeys` in desktop mode as a hard requirement (Principal item #4). The implementation kept it active — the global shortcut was removed, so disabling browser hotkeys would eliminate all keyboard shortcuts in the desktop webview. `Ctrl+Shift+Y` and `Ctrl+Shift+X` provide copy and clear during dictation. This deviation was reviewed and accepted by the Principal during v3.3 review.

**v3.3 — close-to-minimize.** The implementation plan specified `window.hide()` on `CloseRequested`. The implementation uses `window.minimize()` — correct for WSLg where hidden windows are inaccessible (no tray, no global hotkey). The second-close escape hatch was a Principal suggestion adopted during review. On native Linux with a working tray, switching to `window.hide()` is the right behavior (documented as TODO).
