# Voice Scribe

A local voice input system for developer workflows. Runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on a local GPU, streams transcription over WebSocket to a browser UI, and supports both push-to-talk and continuous dictation with client-side voice activity detection. No cloud services, no stored audio, no retained transcripts.

## What it does

- **Push-to-talk** — record an utterance, get a transcript, copy it.
- **Continuous dictation** — mic stays open, client-side VAD ([Silero v4](https://github.com/snakers4/silero-vad), ONNX/WASM) gates speech, transcripts accumulate with automatic paragraph breaks based on speech timing.
- **Voice commands** — say "copy" or "clear" during continuous dictation. Exact-segment detection, stripped from output.
- **Hotkeys** — `Ctrl+Shift+Space` (record), `Ctrl+Shift+Y` (copy), `Ctrl+Shift+X` (clear), `Ctrl+Shift+S` (settings).
- **Live model swapping** — switch between Whisper models at runtime from the settings panel. Thread-safe reload with VRAM cleanup.
- **WebSocket streaming** — transcript segments arrive as faster-whisper produces them. HTTP POST fallback if the connection fails.

## Architecture

Two services over localhost. The frontend runs on the host. The backend runs in Docker with GPU passthrough.

```
Browser (localhost:5173)                API container (localhost:8000)
┌─────────────────────────┐             ┌──────────────────────────────┐
│ React + Vite            │  WebSocket  │ FastAPI + faster-whisper     │
│ MediaRecorder / VAD     │────────────>│ ffmpeg transcode             │
│ Voice commands, hotkeys │<────────────│ GPU inference (CUDA)         │
└─────────────────────────┘  segments   └──────────────────────────────┘
```

Audio is transient — deleted in a `finally` block after processing. Transcripts exist only in browser state and vanish on refresh. Nothing is logged, stored, or sent off-machine.

## Quick start

```bash
# Verify GPU + Docker readiness
make gpu-check

# Start API container (GPU) + frontend dev server
make dev
```

Frontend: `http://localhost:5173` | API: `http://localhost:8000`

## Requirements

- NVIDIA GPU with CUDA support
- Docker Desktop with WSL 2 backend
- Node.js 20+
- Chrome

See [docs/gpu-setup.md](docs/gpu-setup.md) for GPU and driver troubleshooting.

## Development

```bash
make dev        # Start API container + frontend dev server
make api        # API container only
make web        # Frontend dev server only
make build      # Build the API Docker image
make test       # Run all tests (backend + frontend)
make gpu-check  # Verify GPU/container readiness
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
  api/          FastAPI backend (Docker, GPU inference)
  web/          React + TypeScript frontend (Vite)
ops/
  docker/       Compose config, GPU passthrough
  scripts/      Smoke test, GPU bootstrap check
docs/
  gpu-setup.md  GPU/WSL2/Docker troubleshooting
  v2/           Presentation and delivery report (frozen, v2 complete)
  v3/           Presentation (living, updated as v3 milestones ship)
  diagrams/     Mermaid source files for all diagrams
```

## Current state

v2.3.3. Push-to-talk, continuous dictation, streaming, voice commands, hotkeys, and settings are all in the browser version.

Next: a [Tauri v2](https://v2.tauri.app/) desktop application. Planned capabilities: native clipboard write (no focus requirement), direct text injection into the focused application, global hotkeys, system tray. See `roadmap.md` for scope and sequencing.

## License

Private. Not yet licensed for distribution.
