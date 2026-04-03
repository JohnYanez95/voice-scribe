# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice Scribe is a local-first speech-to-text tool for development workflows. A user records speech in a browser UI, a GPU-accelerated containerized backend transcribes it locally using faster-whisper, and the transcript is returned to an editable text area for review and clipboard copy. No cloud services are involved.

**Current milestone:** v1 Complete — v1.1 planning in progress.

**Key context:**
- Two-service system: React frontend (host, port 5173) + FastAPI backend (Docker, port 8000) over localhost HTTP
- Single-user, single-utterance, synchronous — no streaming, no queues, no WebSocket
- Privacy-first: audio is transient (deleted after processing), transcripts are never logged, API binds to localhost only
- `roadmap.md` is the single source of truth for scope decisions
- v1.1 priority: rule-based transcript cleanup function, then state machine diagram update, then settings UI, then retention controls

**Team review structure:** Principal (architectural standards, sign-off), PM (scope, delivery rhythm, compliance), Senior Engineer (implementation risk, integration gaps). Global agent personas in `~/.claude/agents/` reference this section for project-specific context.

## Commands

```bash
# Development
make dev          # Start API container (GPU) + frontend dev server
make api          # Start API container only
make web          # Start frontend dev server only (port 5173)
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

Two-service system over localhost HTTP. No proxy, no WebSocket, no queue.

- **Frontend** (`apps/web/`, port 5173): React + TypeScript + Vite. Records audio via MediaRecorder, POSTs blob to API, displays editable transcript with clipboard copy.
- **Backend** (`apps/api/`, port 8000): FastAPI in Docker with GPU. Validates upload, transcodes via ffmpeg to 16kHz mono WAV, runs faster-whisper inference, returns transcript.

Request flow: `Browser MediaRecorder (webm/opus)` → `POST /transcribe (multipart)` → `MIME validation` → `ffmpeg transcode` → `faster-whisper inference` → `TranscribeResponse JSON` → `editable textarea`

### Key backend files
- `app/main.py` — FastAPI app, CORS, lifespan (model loading)
- `app/config.py` — Settings from environment variables
- `app/routes/transcribe.py` — Upload handling, MIME validation, ffmpeg, temp cleanup
- `app/services/transcription.py` — Model singleton, inference wrapper

### Key frontend files
- `src/app/App.tsx` — State management, orchestrates recorder → API → transcript
- `src/hooks/useRecorder.ts` — MediaRecorder with explicit webm/opus codec request
- `src/services/api.ts` — Typed fetch calls to localhost:8000

### Ops
- `ops/docker/compose.dev.yml` — GPU passthrough, volume mounts for model cache and temp
- `ops/scripts/bootstrap_gpu_check.sh` — Pre-flight GPU verification
- `ops/scripts/smoke_test.sh` — E2E curl test against running API

## Hard Requirements

These patterns are non-negotiable in this codebase:

**Temp file cleanup** — Always use `tempfile.NamedTemporaryFile(delete=False)` inside `try/finally` that calls `os.unlink()`. No bare `os.remove()` in a try block.

**Never log transcript content or raw audio** — Operational telemetry only: model download, transcode start/complete, inference start/complete (with durations and formats, not content).

**MIME validation** — Separate function (`validate_mime_type`) so magic-byte checking can be added as a one-line change. Allowed: `audio/webm`, `audio/ogg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/mpeg`.

**CORS** — Must allowlist both `http://localhost:5173` and `http://127.0.0.1:5173`.

**MediaRecorder** — Must explicitly request `audio/webm;codecs=opus` and check `isTypeSupported()` before recording. Show clear error if unsupported.

**Request limits** — 60s max audio, 10MB max upload, one file per request.

## Presentation Maintenance

`docs/v1/presentation/main.tex` is a living onboarding document, not a snapshot. Two diagrams require active maintenance:

- **Privacy data flow diagram** — must stay in sync with any change to how audio or transcript data moves through the system (new storage, new endpoints, retention changes). Principal's instruction: "it rots fast once people stop maintaining it."
- **State machine diagram** — must be updated *before* writing component code whenever v1.1+ adds UI states (settings toggle, cleanup mode, etc.). Diagram first, then code.

## Scope

v1 is intentionally narrow: record one utterance, transcribe locally, display in editable textarea, copy to clipboard. Do not add streaming, continuous dictation, async queues, background workers, or reverse proxy. The roadmap (`roadmap.md`) is the source of truth for scope decisions.
