# Voice Scribe

A local voice input system for developer workflows. Runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on a local GPU, streams transcription over WebSocket to a browser UI, and supports both push-to-talk and continuous dictation with client-side voice activity detection. No cloud services, no stored audio, no retained transcripts.

## What it does

- **Push-to-talk** — record an utterance, get a transcript, copy it.
- **Continuous dictation** — mic stays open, client-side VAD ([Silero v4](https://github.com/snakers4/silero-vad), ONNX/WASM) gates speech, transcripts accumulate with automatic paragraph breaks based on speech timing.
- **Voice commands** — say "copy" or "clear" during continuous dictation. Exact-segment detection, stripped from output.
- **Hotkeys** — `Ctrl+Shift+Space` (record), `Ctrl+Shift+Y` (copy), `Ctrl+Shift+X` (clear), `Ctrl+Shift+S` (settings). In desktop mode, `Ctrl+Shift+Space` and `Ctrl+Shift+S` are intercepted by WebKitGTK and do not fire; Y and X work reliably.
- **System tray** — close-to-minimize with tray icon. Context menu (Record, Settings, Quit). Tooltip reflects recording state. Second close quits.
- **Live model swapping** — switch between Whisper models at runtime from the toolbar. Thread-safe reload with VRAM cleanup.
- **Light/dark theme** — toggle between dark (default) and light palettes. Preference persisted to `localStorage`, applied before first paint to prevent flash.
- **WebSocket streaming** — transcript segments arrive as faster-whisper produces them. HTTP POST fallback if the connection fails.

## Architecture

Two services over localhost. The frontend runs on the host (browser or Tauri webview). The backend runs in Docker (browser mode) or as a Tauri-managed Python sidecar (desktop mode).

```
Frontend (localhost:5174)               API (localhost:8084)
┌─────────────────────────┐             ┌──────────────────────────────┐
│ React + Vite            │  WebSocket  │ FastAPI + faster-whisper     │
│ MediaRecorder / VAD     │────────────>│ ffmpeg transcode             │
│ Voice commands, hotkeys │<────────────│ GPU inference (CUDA)         │
└─────────────────────────┘  segments   └──────────────────────────────┘
```

Desktop mode adds a Rust HTTP server on port 8001 for native clipboard writes (`arboard`) and audio cue playback (`rodio`), bypassing WebKitGTK's unreliable media subsystem.

Audio is transient — deleted in a `finally` block after processing. Transcripts exist only in browser/webview state and vanish on refresh. Nothing is logged, stored, or sent off-machine.

## Quick start

```bash
# Browser mode — GPU (requires NVIDIA GPU + Container Toolkit)
make gpu-check   # verify GPU + container readiness
make dev         # start API container (CUDA) + frontend dev server

# Browser mode — CPU (no GPU required)
make dev-cpu     # start API container (CPU, small model) + frontend dev server

# Desktop mode — Tauri app with bare-host sidecar
make desktop     # start Tauri desktop app (GPU)
make desktop-cpu # start Tauri desktop app (CPU fallback)
```

Frontend: `http://localhost:5174` | API: `http://localhost:8084`

See [docs/docker-setup.md](docs/docker-setup.md) for browser mode setup and [docs/v3/host-setup.md](docs/v3/host-setup.md) for desktop mode setup.

## Requirements

**Browser mode** (Docker):
- Docker Engine or Docker Desktop
- Node.js 20+
- GPU mode: NVIDIA GPU with CUDA support and drivers on the host

**Desktop mode** (Tauri):
- Rust toolchain, Python 3.10+, ffmpeg, NVIDIA drivers
- Linux system dependencies (WebKitGTK, GStreamer, ALSA)
- Tested on Ubuntu 22.04.5 LTS

### GPU sizing (default model: `large-v3`, float16)

Measured at the v4.0 field test (2026-08-01, RTX 3090 on WSL2 — full numbers in
`roadmap.md`): the service uses ~4.0 GiB VRAM idle with the model loaded and ~5.3 GiB
peak while streaming; streaming holds a 0.64 GPU duty cycle (p95 tick occupancy 0.58 of
the 750 ms budget) and one-shot transcription runs at roughly 12–17× real time.

- **Recommended (large-v3):** RTX 3090 / 4080-class or better, ≥ 10 GB VRAM. Meets all
  latency targets with headroom for model swaps and a desktop compositor sharing the GPU.
- **Minimum (large-v3):** ≥ 8 GB VRAM and roughly half a 3090's fp16 throughput
  (RTX 3060 Ti / 4060-class — estimated from relative throughput, not tested). Streaming
  still works but sits in sustained overrun: the backpressure ladder doubles the tick
  interval, so partials arrive at ~1.5 s cadence instead of 750 ms; one-shot latency
  roughly doubles.
- **Below that:** set `WHISPER_MODEL=medium` (about half the decode cost) or `small` —
  a 6 GB card runs `medium` comfortably. With no CUDA GPU, `make desktop-cpu` (or the CPU
  compose profile) runs `small` in int8: one-shot dictation is usable, streaming is not.

## Development

```bash
make dev          # Start API container (GPU) + frontend dev server
make dev-cpu      # Start API container (CPU) + frontend dev server
make desktop      # Start Tauri desktop app (GPU sidecar)
make desktop-cpu  # Start Tauri desktop app (CPU sidecar)
make api          # API container only
make web          # Frontend dev server only
make build        # Build the API Docker image
make test         # Run all tests (backend + frontend)
make gpu-check    # Verify GPU/container readiness
```

```bash
# Run tests individually
cd apps/api && python -m pytest tests/ -v         # Backend
cd apps/web && npx vitest run                      # Frontend
cd apps/web && npx tsc --noEmit                    # Type check
```

## Project structure

```
apps/
  api/          FastAPI backend (Docker or bare-host sidecar, GPU inference)
  web/          React + TypeScript frontend (Vite, serves browser and Tauri)
  desktop/      Tauri v2 desktop shell (sidecar lifecycle, native clipboard/audio)
ops/
  docker/       Compose config, GPU passthrough
  scripts/      Smoke test, GPU bootstrap check
docs/
  docker-setup.md  Docker/browser mode setup and troubleshooting
  v1/           Delivery report and presentation (frozen, v1 historical)
  v2/           Presentation and delivery report (frozen, v2 complete)
  v3/           Host setup, progress report, presentation (living)
  diagrams/     Mermaid source files for all diagrams
```

## Current state

v3.4 — feature-complete. Voice Scribe captures speech, transcribes locally, and delivers text through an editable transcript pane with clipboard integration. Both push-to-talk and continuous dictation with voice commands work in browser and desktop modes. The desktop app runs in the system tray with close-to-minimize, recording-state tooltip, and sidecar lifecycle management. The UI ships a coherent design system — self-hosted fonts, CSS custom properties, light/dark theme — with model selection in the toolbar and a raw/cleaned comparison pane. 178 tests pass (134 frontend, 44 backend), TypeScript clean, Rust clean.

Both browser and desktop modes share the same backend code and web UI. Desktop mode adds native OS access (clipboard via `arboard`, audio via `rodio`) through a Rust HTTP server, bypassing WebKitGTK limitations.

Voice Scribe is the capture primitive. Transformation, routing, and instrumentation belong to downstream products. See `roadmap.md` for scope boundaries and adjacent projects.

## License

Apache License 2.0. See [LICENSE](LICENSE).
