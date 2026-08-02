# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice Scribe is a local-first speech-to-text tool for development workflows. A user records speech, a GPU-accelerated backend transcribes it locally using faster-whisper, and the transcript is returned to an editable text area for review and delivery. Two runtime contexts: browser (React UI + Docker backend) and desktop (Tauri webview + bare-host Python sidecar). No cloud services are involved.

**Current milestone:** v4.1 (frontend streaming integration) built on branch `v4-streaming`, 2026-08-01 — after the three-persona plan consult. Landed in order: `onFrameProcessed` de-risk spike (PASS — harness `apps/web/spike/`, findings in the roadmap v4.1 bullet), protocol amendments (ping keepalive C3.8 with `idle_timeout_s` capability signal, C2.4/C2.5/C4.6 reconciliations, C10.2 default degrade rule, C10.3 FIFO retention, 1500 s session rotation), diagrams-before-code, capture plumbing (useVAD per-frame tap + pre-roll ring + redemption-tail gating, `streamSession.ts`, live region, App integration), and the stream_bench WER re-spec + two recorded gate runs. Remaining before v4.1 sign-off: live browser/WebKitGTK/mic smoke (human-in-the-loop), VAD detection lag measurement, and the finalization-tail latency carry (v4.2 lever). Streaming ingestion is capture-layer work; the downstream-product boundary is unchanged.

**Key context:**
- Two-service system: React frontend (host, port 5174) + FastAPI backend (port 8084) over localhost. Backend runs in Docker (browser mode) or as a Tauri-managed Python sidecar (desktop mode)
- `platform.ts` is the single routing surface for platform-conditional behavior: `isDesktop()`, `writeClipboard()`, `submitText()`, `emitRecordingState()`. Components call `platform.*` and are unaware of runtime context
- Desktop clipboard + audio: HTTP server (`tiny_http` on port 8001) in the Rust process. POST `/clipboard` writes to system clipboard via `arboard`. POST `/audio/play` plays embedded WAV cues via `rodio`, bypassing WebKitGTK's unreliable audio subsystem. Both bypass WebKitGTK's user-activation requirement so voice commands work without focus. The Tauri clipboard plugin was tested and permanently rejected (crashes WebKitGTK — see progress report Triage #6)
- Privacy-first: audio is transient (deleted after processing), transcripts are never logged or stored, API binds to localhost only
- `roadmap.md` is the single source of truth for scope decisions
- 308 tests (190 frontend, 118 backend), TypeScript clean, Rust clean
- v2 sequence: ~~v2.0 (hotkeys + settings)~~ → ~~v2.1 (streaming + VAD)~~ → ~~v2.2 (continuous mode)~~ → ~~v2.3 (voice commands: copy, clear)~~
- v3 sequence: ~~v3.0 (Tauri shell + sidecar)~~ → ~~v3.1 (platform.ts + native clipboard)~~ → ~~v3.2 (audio feedback, clipboard cleanup, segmentation fix)~~ → ~~v3.3 (system tray + window management)~~ → ~~v3.4 (design system + theme toggle + model selector extraction)~~. v3.4 is the last mainline milestone — Voice Scribe is the capture primitive; transformation/routing/instrumentation belongs to downstream products (see Adjacent Projects in roadmap)

**Team review structure:** Principal (architectural standards, sign-off), PM (scope, delivery rhythm, compliance), Senior Engineer (implementation risk, integration gaps). Global agent personas in `~/.claude/agents/` reference this section for project-specific context.

## Commands

```bash
# Development
make dev          # Start API container (GPU) + frontend dev server
make api          # Start API container only
make web          # Start frontend dev server only (port 5174)
make desktop      # Start Tauri desktop app (Vite + cargo tauri dev)
make desktop-cpu  # Desktop app with CPU fallback (small model, no CUDA)
make gpu-check    # Verify GPU/Docker readiness (run before first dev)
make build        # Build the API Docker image

# Tests
make test                              # Run all tests (backend + frontend)
cd apps/api && python -m pytest tests/ -v          # Backend only
cd apps/api && python -m pytest tests/test_health.py -v  # Single test file
cd apps/web && npx vitest run          # Frontend only
cd apps/web && npx vitest run tests/Transcript.test.tsx  # Single test file
cd apps/web && npx tsc --noEmit        # Frontend type-check

# Smoke test (requires running API container)
bash ops/scripts/smoke_test.sh ops/scripts/test.mp3

# Docker
docker compose -f ops/docker/compose.dev.yml up --build   # Build and start
docker compose -f ops/docker/compose.dev.yml down          # Stop
```

Backend tests run on the host (the test suite mocks model loading and does not require CUDA). The Docker container is only needed to run the actual service with GPU inference.

## Architecture

Two-service system over localhost. WebSocket (default, v2.1+) and HTTP (fallback). No proxy, no queue.

- **Frontend** (`apps/web/`, port 5174): React + TypeScript + Vite. Records audio via MediaRecorder, streams to API via WebSocket, displays editable transcript. `platform.ts` routes clipboard/submit calls by runtime context. One Vite build serves both browser and Tauri webview. Design system: self-hosted fonts (Hanken Grotesk, Crimson Pro) loaded via `@font-face`, all colors as CSS custom properties on `:root`. Light/dark theme via `data-theme` attribute on `<html>`; flash-prevention script in `index.html` sets the attribute before React mounts.
- **Backend** (`apps/api/`, port 8084): FastAPI with GPU. Validates upload, transcodes via ffmpeg to 16kHz mono WAV, runs faster-whisper inference, returns transcript. Runs in Docker (browser mode) or as bare-host Python process (desktop mode) — same code, different process boundary.
- **Desktop shell** (`apps/desktop/src-tauri/`): Tauri v2. Spawns the Python API as a sidecar, polls health, emits `backend-ready` event. HTTP clipboard + audio server on port 8001 (`tiny_http` + `arboard` + `rodio`). System tray with context menu and recording-state tooltip. Close-to-minimize with second-close quit. WebKitGTK media permissions granted programmatically. CUDA runtime discovery via `cuda_ld_library_path()`. WebKitGTK intercepts `Ctrl+Shift+Space` and `Ctrl+Shift+S` at the native level — `Ctrl+Shift+Y` (copy) and `Ctrl+Shift+X` (clear) work reliably.

Request flow (WebSocket): `MediaRecorder (webm/opus)` → `WebSocket /ws/transcribe` → `ffmpeg transcode` → `faster-whisper inference` → `streaming transcript JSON` → `editable textarea`

Request flow (HTTP fallback): `MediaRecorder (webm/opus)` → `POST /transcribe` → `MIME validation` → `ffmpeg transcode` → `faster-whisper inference` → `TranscribeResponse JSON` → `editable textarea`

Request flow (streaming session, v4.0+, backend only until v4.1): `16 kHz mono pcm_f32le frames` → `WebSocket /ws/stream` (protocol v1, `docs/v4/protocol.md`) → `in-memory buffer (no ffmpeg, no temp files)` → `paced re-decode + LocalAgreement commit` → `partial / committed / final JSON`

**Backend contract:** `docs/contract/runtime-contract.md` is the stable description of request/response shapes, hard limits, and privacy guarantees for downstream consumers. Any change that touches endpoint shapes or constraints must update the contract doc and regenerate `docs/contract/runtime-contract.schema.json` (`cd apps/api && python scripts/export_contract.py`). The drift test (`tests/test_contract_export.py`) will fail if the schema file is not updated.

### Key backend files
- `app/main.py` — FastAPI app, CORS, lifespan (model loading)
- `app/config.py` — Settings from environment variables (incl. WHISPER_AVAILABLE_MODELS)
- `app/routes/transcribe.py` — Upload handling, MIME validation, ffmpeg, temp cleanup
- `app/routes/models.py` — Model list and runtime swap endpoints (v2.0; 409 during active stream, v4.0)
- `app/routes/stream_ws.py` — `/ws/stream` session loop: handshake, frame validation, paced decode, flush/stop/reset (v4.0)
- `app/services/stream_policy.py` — LocalAgreement commit policy as pure functions, absolute sample coordinates (v4.0)
- `app/services/stream_guard.py` — single-lock session/swap mutual exclusion (v4.0)
- `app/services/transcription.py` — Model singleton with threading lock, swap logic, inference wrapper, load-time warmup decode
- `ops/scripts/stream_bench.py` — streaming measurement harness: latency anchors, retraction reducer, cost comparison (v4.0)

### Key frontend files
- `src/app/App.tsx` — State management, orchestrates recorder → API → transcript, voice command dispatch
- `src/hooks/useRecorder.ts` — MediaRecorder with explicit webm/opus codec request
- `src/hooks/useHotkeys.ts` — Ctrl+Shift keyboard shortcuts at App level (v2.0)
- `src/features/model-selector/ModelSelector.tsx` — Toolbar model selector; gates fetch on `backendReady`, renders swap status inline (v3.4)
- `src/features/settings/Settings.tsx` — Settings panel: recording mode, display options, audio mute, max recording duration (v2.0; model selection removed in v3.4)
- `src/services/api.ts` — Typed fetch calls to localhost:8084
- `src/services/streamSession.ts` — Persistent `/ws/stream` session client: handshake, wire framing, ping keepalive, stale-utterance filter, C10.2 degrade mapping (v4.1; never imports api.ts)
- `src/services/platform.ts` — Platform detection (`isDesktop`), clipboard routing, submit stub (deferred), recording state emission to Rust
- `src/services/audio.ts` — Audio cue playback: browser (HTMLAudioElement) or desktop (POST to Rust rodio server) (v3.2)
- `src/services/voiceCommands.ts` — Command detection: copy, clear (v2.3)

### Key desktop files
- `apps/desktop/src-tauri/src/main.rs` — Sidecar lifecycle, HTTP clipboard + audio server, system tray, close-to-minimize, recording state listener, WebKitGTK permissions, CUDA discovery
- `apps/desktop/src-tauri/tauri.conf.json` — CSP (ports 8084, 8001), devUrl, `withGlobalTauri`

### Ops
- `ops/docker/compose.dev.yml` — GPU passthrough, volume mounts for model cache and temp
- `ops/scripts/bootstrap_gpu_check.sh` — Pre-flight GPU verification
- `ops/scripts/smoke_test.sh` — E2E curl test against running API

## Hard Requirements

These patterns are non-negotiable in this codebase:

**Temp file cleanup** — Always use `tempfile.NamedTemporaryFile(delete=False)` inside `try/finally` that calls `os.unlink()`. No bare `os.remove()` in a try block.

**Never log transcript content or raw audio** — Operational telemetry only: model download, transcode start/complete, inference start/complete (with durations and formats, not content).

**MIME validation** — Separate function (`validate_mime_type`) so magic-byte checking can be added as a one-line change. Allowed: `audio/webm`, `audio/ogg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/mpeg`.

**CORS** — Must allowlist `http://localhost:5174`, `http://127.0.0.1:5174`, `https://tauri.localhost`, and `tauri://localhost`.

**MediaRecorder** — Must negotiate a supported audio MIME type from a prioritized list (`audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/webm`, `audio/ogg`) via `isTypeSupported()` before recording. When no format is supported, fall back to `ScriptProcessorNode` PCM capture with `encodeWav()`. Show clear error if neither path works.

**Request limits** — 60s max audio, 10MB max upload, one file per request **on the one-shot paths** (`POST /transcribe`, `/ws/transcribe`). The max recording duration setting in Settings is capped at 60s to match this limit — do not raise the UI cap without also raising the backend limit. The streaming path (`/ws/stream`) is governed by its own limits table in `docs/v4/protocol.md` §6 (frame size, uncommitted-buffer cap, forced flush, session ceiling, idle timeout) — not by the 60s/10MB rule.

## Presentation Maintenance

`docs/v3/presentation/main.tex` is the living onboarding document. The v1 and v2 decks are frozen historical artifacts. Two diagrams in `docs/diagrams/` require active maintenance:

- **Privacy data flow diagram** (`privacy-data-flow.mmd`) — must stay in sync with any change to how audio or transcript data moves through the system (new storage, new endpoints, retention changes). Principal's instruction: "it rots fast once people stop maintaining it."
- **State machine diagram** (`state-machine.mmd`) — must be updated *before* writing component code whenever new UI states are added. Diagram first, then code.

Diagram sources are versioned by milestone: `docs/diagrams/*.mmd` (living), `docs/v2/diagrams/*.mmd` (frozen v2 snapshots), `docs/v3/diagrams/*.mmd` (v3-specific). PNGs rendered via `mmdc --scale 2`.

## Scope

v1/v1.1 is intentionally narrow: record one utterance, transcribe locally, display in editable textarea, copy to clipboard. v2 adds streaming, continuous dictation, hotkeys, and voice commands. v3 adds the Tauri desktop shell, platform abstraction, native OS access (clipboard, audio playback), audio feedback for voice commands, system tray with background operation, and window management. v3.4 adds the design system (self-hosted fonts, CSS custom properties, light/dark theme), model selector extraction into the toolbar, layout refactor (three-zone toolbar + main area), and comparison panes. Global shortcut registration was implemented and removed — XGrabKey does not deliver events on WSLg; re-addition is a Rust-only change when validated on native Linux. Direct text injection is deferred indefinitely — downstream products use command draft/staging instead. Do not add async queues, background workers, or reverse proxy. The roadmap (`roadmap.md`) is the source of truth for scope decisions.
