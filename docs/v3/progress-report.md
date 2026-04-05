# Voice Scribe v3.0 — Progress Report

**Date:** April 5, 2026
**Author:** Johnraymond Yanez
**Status:** Phase B complete — desktop app records and transcribes via GPU on bare host

---

## Current State

The Tauri desktop application launches, spawns the Python API as a sidecar, waits for health, and transitions the UI from "Starting backend..." to an active Record button. Push-to-talk recording through the desktop webview produces GPU-accelerated transcription at sub-second inference latency (0.8–1.0s on large-v3).

111 automated tests pass (70 frontend, 41 backend). Rust compiles clean with zero warnings. TypeScript compiles clean.

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
| `docs/v3/host-setup.md` | Pending |

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
| `Cargo.toml` | Dependencies: tauri 2, tauri-plugin-shell 2, reqwest (blocking), webkit2gtk (Linux), libc (Unix) |
| `tauri.conf.json` | devUrl `http://localhost:5173`, CSP allowing API and WebSocket on localhost:8000, `wasm-unsafe-eval` for ONNX VAD runtime |
| `capabilities/default.json` | Tauri v2 capability permissions for shell spawn/kill and events |
| `build.rs` | Standard Tauri build script |
| `src/main.rs` | Sidecar lifecycle, WebKitGTK media permissions, shutdown handler |
| `icons/icon.png` | 32x32 placeholder |

### Sidecar Lifecycle

`main.rs` implements the full sidecar lifecycle:

**Spawn.** `find_uvicorn()` resolves the Python executable — checks `apps/api/.venv/bin/uvicorn` first, falls back to system PATH. `cuda_ld_library_path()` discovers CUDA runtime libraries installed as pip packages under `site-packages/nvidia/*/lib/` and injects them via `LD_LIBRARY_PATH` on the spawned process. Without this, `ctranslate2` cannot dlopen `libcublas.so.12` on bare-host setups where CUDA toolkit is not system-installed.

**Health poll.** Background thread polls `GET http://127.0.0.1:8000/health` every 500ms with a 120-second timeout. On success, emits `backend-ready` Tauri event to the webview. On timeout or sidecar crash, shows an error dialog and exits. Crash detection checks `Child::try_wait()` each poll cycle — a sidecar that exits with non-zero (port conflict) is surfaced immediately, not after the full timeout.

**Shutdown.** `on_window_event` handler sends SIGTERM on `CloseRequested`. Waits up to 5 seconds for graceful exit, then SIGKILL. The `Child` handle is stored in `Mutex<Option<Child>>` as Tauri managed state, accessible from both the health poll thread and the window event handler.

### CORS

`config.py` default `CORS_ORIGINS` now includes `https://tauri.localhost` (Windows/WSL2 Tauri origin) and `tauri://localhost` (Linux Tauri origin). Both `main.py` CORS middleware and `transcribe_ws.py` WebSocket origin check read from the same `settings.cors_origins` property — one default update covers both surfaces.

### Backend-Readiness Gate

`App.tsx` detects Tauri context via `typeof window.__TAURI__ !== "undefined"` at module scope. In browser context, `backendReady` starts `true` — no gate, no behavior change. In Tauri context, `backendReady` starts `false` and a `useEffect` listens for the `backend-ready` event. `Recorder.tsx` shows "Starting backend..." when `!backendReady`. Two new tests cover both contexts (dynamic import with `vi.resetModules()` for the Tauri path).

### Makefile

`make desktop` starts Vite as a background process, writes its PID to `/tmp/voice-scribe-vite.pid`, traps EXIT/INT/TERM, then runs `cargo tauri dev`. `PATH` export at the top of the Makefile includes `~/.cargo/bin` so `cargo` is findable from `/bin/sh`.

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

---

## Runtime Warnings (Non-Blocking)

Two WebKitGTK warnings appear in the terminal during desktop operation. Neither affects functionality.

| Warning | Cause | Impact |
|---|---|---|
| `Unable to connect to D-Bus session bus` | WSL2 does not provide a D-Bus session bus by default | None — WebKitGTK falls back gracefully |
| `g_object_set_is_valid_property: object class 'GstAppSrc' has no property named 'automatic-eos'` | GStreamer version mismatch between WebKitGTK's expectation and the installed GStreamer 1.20 | None — recording and playback work |

---

## Test State

| Suite | Count | Status |
|---|---|---|
| Frontend (vitest) | 70 | All pass |
| Backend (pytest) | 41 | All pass |
| Rust (cargo check) | — | Clean, zero warnings |
| TypeScript (tsc --noEmit) | — | Clean |
| **Total** | **111** | **Green** |

New tests added in Phase B:

| Test | File | Verifies |
|---|---|---|
| Browser context: Record button enabled on mount | `App.test.tsx` | `backendReady` defaults true when `__TAURI__` absent |
| Tauri context: disabled until backend-ready event | `App.test.tsx` | `backendReady` starts false, transitions to true on event |

---

## What Remains Before v3.0 Gate

1. **`docs/v3/host-setup.md`** — Document the bare-host setup procedure: Rust toolchain, system dependencies, `nvidia-cublas-cu12` pip package, and verification steps. The content is now fully known from the triage — this is documentation, not discovery.
2. **Manual gate validation** — The gate checklist items that require a running desktop app: continuous mode, voice commands ("copy", "clear"), settings panel, WebSocket origin verification, sidecar cleanup on close, clean relaunch. Push-to-talk with GPU inference is confirmed.
3. **Commit Phase B work** — All changes are in the working tree, not yet committed.

---

## Reviewer Notes

### For PM

Scope held. Phase B delivered the five planned deliverables plus two triage fixes that were direct consequences of the bare-host transition (CUDA runtime, WebKitGTK permissions). No scope additions — both fixes address runtime requirements that were always implicit in "desktop app records audio with GPU inference" but only became visible at integration time.

The `useRecorder.ts` error message update was flagged by the Principal during triage review. One-line change, context-neutral wording.

The `docs/v3/host-setup.md` deliverable is the remaining documentation obligation. Its content is fully determined — no open questions.

### For Principal

**WebKitGTK permission model.** The two-layer pattern (feature gate + signal handler) is documented in WebKitGTK's API but not surfaced by Tauri's abstraction layer. The failure mode was silent denial — `getUserMedia` rejected with `NotAllowedError`, no prompt, no WebKitGTK-level error. `set_enable_media_stream(true)` alone was the incomplete fix that initially appeared correct because it compiled and the feature gate error message changed. The signal handler (`connect_permission_request`) was the missing layer.

**CUDA runtime discovery.** `cuda_ld_library_path()` queries Python's `site.getusersitepackages()` at sidecar spawn time, scans `nvidia/*/lib/` directories, and injects the result via `LD_LIBRARY_PATH`. This is narrowly scoped to pip-installed NVIDIA packages. If the user has a system CUDA toolkit (`/usr/local/cuda/lib64`), the existing `LD_LIBRARY_PATH` is preserved and appended. The function does not modify the parent process environment.

**Scope coupling in `cuda_ld_library_path()`.** The function queries `site.getusersitepackages()` — it only finds CUDA libraries installed at user scope (`pip install --user nvidia-cublas-cu12`). If someone installs the package inside the venv, the libraries land in `.venv/lib/python3.x/site-packages/nvidia/cublas/lib/` and the function won't find them. Two paths forward: `docs/v3/host-setup.md` specifies user-scope installation and explains why, or the function is updated to also scan the venv's `site-packages`. Either way, the coupling should be named explicitly in the setup documentation.

**`resource_dir()` vs `CARGO_MANIFEST_DIR`.** The API directory resolution was simplified to `CARGO_MANIFEST_DIR` only. `resource_dir()` is the correct approach for production bundles but returned `target/debug/` in dev mode, producing a wrong relative path. Mixing both in an `or_else` chain masked the dev-mode failure because `resource_dir()` succeeded (returned a path) but the path was wrong. The compile-time constant is correct for all dev builds and makes the failure mode obvious if the directory doesn't exist (panic with path in message). Production bundling is post-v3.0. `CARGO_MANIFEST_DIR` bakes the build machine's absolute path into the binary — the moment distribution packaging produces a `.deb` or `.msi`, the API directory resolution must switch to `resource_dir()` or `app.path().resolve()`.

**Outstanding non-blocking items.** D-Bus and GStreamer warnings in WSL2 are cosmetic. `navigator.clipboard` is denied in the Tauri webview (non-HTTPS context) — already guarded with `.catch(() => {})`, native clipboard is v3.1. WebSocket smoke test gap from v2 delivery report remains open.

**Triage as operational reference.** `docs/v3/host-setup.md` should include a troubleshooting section referencing triage items #2 (CUDA runtime — `libcublas.so.12` not found, resolved by `nvidia-cublas-cu12` pip package + `cuda_ld_library_path()` injection) and #4 (WebKitGTK permissions — silent `getUserMedia` denial, resolved by `enable-media-stream` feature gate + `connect_permission_request` signal handler). These are the exact problems someone will hit on a new machine.
