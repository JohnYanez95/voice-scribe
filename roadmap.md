# Voice Scribe — v1 Roadmap

**Last Updated:** April 3, 2026 (updated with v1 review feedback)
**Status:** v1 Complete — v1.1 planning in progress

---

## What This Document Is

This is the single source of truth for building Voice Scribe v1. It consolidates the original design spec, the senior engineer's review, and the principal's execution directives into one reference. If something in this document contradicts an earlier draft, this document wins.

---

## Product Summary

Voice Scribe is a local-first speech-to-text tool for development workflows. A user records speech in a browser UI, a containerized backend transcribes it locally via `faster-whisper`, and the transcript appears in an editable text area for copying into tools like Claude Code.

**v1 scope is intentionally narrow:**

- Record one utterance
- Send it to a local transcription API
- Return transcript text
- Show it in an editable text area
- Copy the result to clipboard

That is the entire v1 product.

**Explicit non-goals for v1:** continuous dictation, live streaming partial transcripts, multi-user deployment, async job queues, background workers, reverse proxies, desktop packaging, long-term audio storage, grammar LLM integration.

---

## Design Principles

**Local-first.** Audio and transcripts stay on the user's machine. No cloud services required.

**Host for interaction, container for inference.** The browser owns mic access, clipboard, and editing. The container owns model loading and inference.

**Audio is transient, text is durable.** Raw audio is short-lived input. Transcripts are the user-facing artifact.

**Scope matches the milestone.** Repo structure and services reflect v1 reality, not v3 aspirations.

**Public-safe defaults.** The repo and runtime assume eventual public distribution and default toward safe behavior.

---

## Architecture

```text
[Browser UI on host]
    ├─ record audio (MediaRecorder, webm/opus)
    ├─ show editable transcript
    └─ copy final text

            │  HTTP (localhost)
            ▼

[Local API in Docker container]
    ├─ GET  /health
    └─ POST /transcribe
            │
            ▼
[faster-whisper + ffmpeg runtime]
```

The frontend runs on the host at `localhost:5173` (Vite). The API runs in a Docker container at `localhost:8000` (FastAPI). Communication is plain HTTP over localhost. No WebSockets, no reverse proxy, no queue.

**Key architectural note (from senior review):** The synchronous FastAPI design is correct for v1, but `faster-whisper` blocks the thread during inference. For a single-user local tool this is fine. If the team later needs cancel buttons or progress spinners, the rework path is `asyncio.to_thread()` wrapping the inference call, or a background task with a polling endpoint. Both change the API contract. This is not a v1 problem — just context the team should carry forward.

---

## Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | TypeScript, React, Vite | Browser mic access, fast iteration, clipboard support |
| Backend | Python, FastAPI | Strong model/audio ecosystem, easy containerization |
| Speech-to-Text | faster-whisper (`large-v3`) | Good accuracy/speed balance on local GPU |
| Transcoding | ffmpeg (in container) | Normalizes browser audio to 16kHz mono WAV |
| Packaging (later) | Tauri | Desktop app path after v1 is validated |

---

## Execution Plan

### Phase 0 — Environment Setup (Days 1–2)

This is the highest-risk phase. GPU passthrough on Windows + WSL2 + Docker Desktop is fragile and sensitive to driver versions, WSL kernel versions, and Docker Desktop settings all being aligned.

**Definition of done — all three checkpoints must be green before writing application code:**

1. `docker compose up` starts the API container
2. `GET /health` returns `"device": "gpu"`
3. The model cache directory contains weights that survive `docker compose down && docker compose up`

Do not move past this phase until all three pass. Writing application code against a broken runtime wastes a full day debugging the wrong layer.

**Model download note:** The first run downloads `large-v3` (~3 GB). In WSL, if the cache volume permissions aren't right, the download will succeed but land in the wrong place and re-download on every restart. Verify cache persistence explicitly after the first run.

**GPU check script:** `ops/scripts/bootstrap_gpu_check.sh` should verify `nvidia-smi` from a CUDA-enabled container before starting the app. This is a prerequisite, not a convenience.

---

### Phase 1 — Backend API (Days 3–5)

Build the API container with a hardcoded test audio file and confirm transcription works end-to-end before integrating with the frontend.

#### Endpoints

**`GET /health`** — Returns service status, model loaded flag, device mode (`gpu` or `cpu`), loaded model name.

**`POST /transcribe`** — Accepts a short audio upload, returns transcript text plus metadata.

Request: `multipart/form-data` with fields `file` (audio file) and `language` (optional hint).

Response: transcript text, language, duration, processing mode, model name.

Error codes: `400` (unsupported MIME), `413` (too large), `422` (malformed request), `500` (transcription/transcoding failure).

#### Audio Format and Transcoding

The browser `MediaRecorder` produces `webm/opus`. Transcoding happens server-side, not in the frontend.

Accepted inputs: `audio/webm`, `audio/ogg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/mpeg`.

Normalized internal format: mono 16kHz WAV via `ffmpeg`.

**Codec note (from senior review):** `MediaRecorder` doesn't guarantee `webm/opus` on every browser. Chrome on Windows is consistent, but Firefox or Edge may produce different formats. For v1, Chrome on Windows is the supported browser — do not build a universal codec negotiation layer. But the frontend must explicitly request `audio/webm;codecs=opus` via the `mimeType` option and fall back gracefully with a user-visible error if the browser doesn't support it.

#### MIME Validation (Hard Requirement)

Check the `Content-Type` header from the multipart upload. Structure the validation function so that adding magic-byte checking later is a one-line addition, not a refactor. For v1, header checking is sufficient.

#### Temp File Cleanup (Hard Requirement)

Use `tempfile.NamedTemporaryFile` with `delete=False` inside a `try/finally`, or write a small context manager that guarantees cleanup on both success and exception paths. No bare `os.remove()` calls in a try block. This pattern must be right in the first commit — every future temp file operation copies it.

The `ffmpeg` transcoding step can accept audio via numpy arrays piped in memory, but the temp-file-then-delete approach is acceptable for v1 as long as cleanup is airtight.

#### Concrete Limits

- Maximum audio duration: 60 seconds
- Maximum request size: 10 MB
- Maximum one file per request
- Default request timeout: 90 seconds
- Reject unsupported MIME types before transcription

#### CORS Configuration

FastAPI CORS middleware must allowlist both `http://localhost:5173` and `http://127.0.0.1:5173`. The browser sends one or the other depending on how the dev server URL was typed. Both must be present from the first commit.

---

### Phase 2 — Frontend (Days 3–5, parallel)

Build the recording flow with a mock API response while the backend is being stood up independently.

#### Core User Flow

1. User presses Record
2. Frontend captures audio via `MediaRecorder` (explicitly requesting `audio/webm;codecs=opus`)
3. If browser doesn't support the codec, show a clear error message
4. User stops recording
5. Frontend sends audio blob to `POST /transcribe`
6. Frontend shows returned transcript in an editable text area
7. User edits if needed, then copies final text to clipboard

#### Frontend Stack

TypeScript + React + Vite. The frontend port (`5173`) is set in `vite.config.ts` or via the Vite CLI `--port` flag, not via an environment variable.

---

### Phase 3 — Integration (Day 6)

Connect the frontend to the live API. If both halves were built and tested independently, integration is a single afternoon.

**Do not over-parallelize.** This is a two-service system with one integration point. The fastest path is one person on the API with a test audio file, one person on the frontend with a mock response, then integration once both halves work.

---

### Phase 4 — End-to-End Smoke Test (Day 6–7)

**Hard requirement:** Create one integration test that sends a real audio file through `/transcribe` and asserts text comes back. This can be a shell script with `curl` that lives in `ops/scripts/`. This becomes the fastest feedback loop for "is the whole stack working." Unit tests on MIME validation won't catch the case where `ffmpeg` silently produces a corrupt WAV and `faster-whisper` returns an empty string.

---

### Phase 5 — Testing and Polish (Days 7–8)

#### Backend Tests (pytest)

Cover: `/health`, `/transcribe` validation, MIME rejection, request limit enforcement, temp file cleanup behavior.

#### Frontend Tests (vitest)

Cover: record flow state transitions, transcript rendering, copy-to-clipboard action, error-state rendering.

**Test philosophy:** Test the happy path plus the obvious failure boundaries. Do not overbuild the test matrix before the first usable version exists.

---

## Operational Logging (Hard Requirement)

The team must be able to see the following in container logs with timestamps from the first commit. Not transcript content (the security posture prohibits that), but operational telemetry:

- `model download started`
- `model download complete, {size}, {duration}`
- `transcode started, input format {format}`
- `transcode complete, output 16kHz mono WAV, {duration}`
- `inference started`
- `inference complete, {duration}`

Use structured logging (`structlog` or consistent prefixed formatting) so output is greppable.

---

## Repository Layout

```text
voice-scribe/
├─ apps/
│  ├─ web/                          # Frontend (React + Vite)
│  │  ├─ src/
│  │  │  ├─ app/
│  │  │  ├─ components/
│  │  │  ├─ features/
│  │  │  │  ├─ recorder/
│  │  │  │  └─ transcript/
│  │  │  ├─ services/
│  │  │  ├─ hooks/
│  │  │  ├─ styles/
│  │  │  └─ types/
│  │  ├─ public/
│  │  ├─ tests/
│  │  └─ package.json
│  │
│  └─ api/                          # Backend (FastAPI)
│     ├─ app/
│     │  ├─ routes/
│     │  │  ├─ health.py
│     │  │  └─ transcribe.py
│     │  ├─ services/
│     │  │  └─ transcription.py
│     │  ├─ config.py
│     │  ├─ schemas.py
│     │  └─ main.py
│     ├─ tests/
│     ├─ pyproject.toml
│     └─ Dockerfile
│
├─ ops/
│  ├─ docker/
│  │  └─ compose.dev.yml
│  └─ scripts/
│     ├─ bootstrap_gpu_check.sh
│     └─ smoke_test.sh              # E2E curl test (hard requirement)
│
├─ data/
│  ├─ tmp/                          # Ephemeral only, gitignored
│  └─ cache/                        # Model weights cache, gitignored
│
├─ docs/
│  ├─ presentations/
│  │  └─ v1/
│  │     ├─ main.tex                    # Beamer slide deck
│  │     └─ main.pdf
│  ├─ architecture.md
│  ├─ gpu-setup.md
│  ├─ privacy.md
│  ├─ threat-model.md
│  └─ release-checklist.md
│
├─ .github/
│  ├─ workflows/
│  ├─ dependabot.yml
│  └─ SECURITY.md
│
├─ .env.example
├─ .gitignore
├─ CLAUDE.md
├─ Makefile
├─ README.md
└─ LICENSE
```

---

## Environment Variables

Ship a real `.env.example` from day one:

```env
API_PORT=8000
DEVICE=cuda
WHISPER_MODEL=large-v3
MAX_AUDIO_SECONDS=60
MAX_UPLOAD_MB=10
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
MODEL_CACHE_DIR=/cache
TEMP_DIR=/tmp/voice-scribe
LOG_LEVEL=info
```

---

## Docker Compose (GPU)

```yaml
services:
  api:
    build:
      context: ../../apps/api
    ports:
      - "8000:8000"
    environment:
      - WHISPER_MODEL=large-v3
      - DEVICE=cuda
      - MAX_AUDIO_SECONDS=60
      - MAX_UPLOAD_MB=10
      - CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
      - TEMP_DIR=/tmp/voice-scribe
    volumes:
      - ../../data/cache:/cache
      - ../../data/tmp:/tmp/voice-scribe
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              capabilities: [gpu]
```

**Fallback:** If GPU is unavailable, start with `DEVICE=cpu`, optionally switch to the `small` model, warn in logs, continue serving.

---

## Model Selection

| Model | When to Use |
|---|---|
| `large-v3` (default) | Accuracy matters, GPU available, machine not heavily shared |
| `small` | Machine under load, faster startup, CPU fallback, debugging |

Target machine has 24 GB VRAM but should not be assumed to be fully dedicated to this tool. Expose model selection via `.env.example`, don't hard-code.

Model weights are not baked into the container image. They download on first run into a host-mounted cache volume and persist across restarts.

---

## Makefile Targets

- `make dev` — start local development services
- `make build` — build the API container
- `make test` — run frontend and backend tests
- `make gpu-check` — verify GPU/container readiness

---

## Security Posture

**Runtime defaults:** Bind to localhost only. Run containers as non-root. Do not log raw audio or transcript content. Cap request size and duration. Restrict CORS origins. Keep secrets out of repo and frontend bundle.

**Audio/data handling:** Delete temp audio immediately after processing. Use dedicated temp directories only. Make retention behavior explicit in docs.

**Supply chain:** Pin dependencies. Scan in CI. Use minimal container images. No privileged containers. Do not mount the Docker socket.

---

## Threat Model Summary

**Main assets:** Microphone audio, transcript text, session metadata, local service availability.

**Main attack surfaces:** Upload endpoint, temp storage, browser origin handling, debug configuration, dependency chain.

**Most likely operational failures:** Accidental LAN exposure, temp audio not cleaned up, transcript content leaking into logs, GPU setup confusion blocking contributors.

---

## Milestones

### v1 (complete)

Record audio, send to local API, transcode, transcribe, return transcript, display in editable text area, copy to clipboard. GPU and CPU execution modes.

**Outstanding v1 close-out item (complete before v1.1 work begins):**
Run `smoke_test.sh` with `DEVICE=cpu` and `WHISPER_MODEL=small`. Confirm a transcript is returned. Record wall-clock latency in a comment at the top of `ops/scripts/smoke_test.sh`. ~30 minutes of work. This is a v1 item, not v1.1 backlog.

### v1.1

Work items in strict priority order:

1. **`clean_transcript(raw: str) -> str`** — single pure function in `apps/api/services/`. Rule-based only: whitespace normalization, punctuation, capitalization, repeated-word removal. No config, no toggles, no settings UI. The `/transcribe` response JSON returns both `raw` and `cleaned` fields for side-by-side quality evaluation. Ship it, run against real dictation for one week, then decide what needs to be configurable. Lives in the API — not the frontend. Do not put regex in the React app.

2. **Settings UI** — separate work item; comes after the cleanup pass is validated.

3. **Retention controls** — separate work item; comes after cleanup. Do not bundle with item 1.

A second GPU-backed model is deferred unless there is demonstrated need.

### v2

Optional desktop packaging (Tauri). Hotkeys. Session history. Smarter silence detection. Optional streaming mode.

---

## Deferred Decisions

These are deferred by design, not by oversight: OpenAPI-generated frontend contracts, domain/infra folder split, queue/background workers, reverse proxy, grammar refinement LLM, WebSocket transport.

---

## Development Environment

**Repo location:** WSL Linux filesystem (e.g., `/home/<user>/projects/voice-scribe`).

**Tools:** VS Code with WSL extension, Docker Desktop with WSL 2 backend, Chrome for frontend testing.

**Supported browser for v1:** Chrome on Windows.

---

## Public Release Checklist (Pre-Release)

Before public release, the repo must include: README, SECURITY.md, privacy docs, threat model docs, release checklist, dependency and secret scanning in CI.

Do not publish with: permissive network exposure, transcript or audio logging enabled by default, committed secrets, real user data, unprotected debug endpoints.

---

## Engineering Rules

**Repository:** No secrets, real audio, real transcripts, or runtime artifacts committed. `.env.example` only.

**Runtime:** Audio discarded by default. Transcription bounded by timeouts. Request size and duration capped. Temp cleanup required. Health endpoint reports actual device mode.

**Product:** Transcript is always editable. User controls final text. Text output matters more than automation. Architecture stays flat until complexity is earned.

---

## Summary

Ship v1 small. Earn the right to make it bigger.

---

## Ideas (Post-v2 Parking Lot)

Not planned. Not scoped. These surfaced naturally while building and are worth remembering when the time is right.

**Docker image size reduction**
The `nvidia/cuda:12.6` base accounts for ~2.1GB of the image on its own. Several CUDA packages installed in that layer — `libnccl` (multi-GPU communication), `libnpp` (signal/image processing) — are not used by faster-whisper for single-GPU inference. Auditing and trimming these could meaningfully reduce image size. Requires rebuilding and running the smoke test to confirm nothing breaks.

**MIME magic-byte validation**
Currently MIME type is checked from the `Content-Type` header, which is self-reported. Adding magic-byte checking (reading the first few bytes of the file and confirming they match the declared format) would be a one-line addition to the existing `validate_mime_type` function. Natural pre-condition before any networking work — not needed for a localhost single-user tool.

**Security hardening as a v2 pre-condition**
Before anything leaves localhost — any network exposure, multi-user path, or public API — the threat model should be revisited. MIME hardening, rate limiting, and bind address controls are the obvious starting points.

**Model selection UI**
`WHISPER_MODEL` is currently set via `.env`. A simple settings panel letting the user toggle between `large-v3` and `small` without editing files would be a natural quality-of-life addition once v1.1's settings UI exists.

**Voice activity detection (VAD) for automatic utterance boundaries**
Rather than manual record/stop, a lightweight VAD layer upstream of the recorder could detect when speech begins and ends automatically — removing the button interaction entirely. A simple dB threshold gate handles the easy cases (silence vs. speech). A lightweight learned VAD like Silero VAD handles harder cases (keyboard noise, background audio). Pairs naturally with streaming partials and smarter silence detection already noted in v2. Simpler version of the idle filtering pattern used in the work project — single speaker, controlled environment, no device disambiguation required.

**Streaming partials**
Faster-whisper supports segment-by-segment output. Surfacing partial transcripts as they arrive rather than waiting for the full result would make long recordings feel more responsive. Requires WebSocket transport and changes the API contract — firmly a post-v2 consideration.

**Single `docker compose up` for full stack**
Currently `docker compose up` only starts the API container — the frontend requires a separate `make web` invocation. Adding the frontend as a second service in `compose.dev.yml` with a Node container running Vite (`--host` flag required so it binds to `0.0.0.0`) would mean one command starts and stops everything together. Small change, meaningful quality of life improvement once the core product is finalized.

**CPU-only deployment path**
The CPU fallback is already wired (`DEVICE=cpu`, `int8` compute type auto-selected) but has not been exercised end-to-end. For use on machines without a GPU — such as a work laptop — the Docker container dependency becomes friction since CUDA is the primary reason the container exists. Worth exploring whether CPU inference could run outside Docker entirely, potentially accelerating the v2 Tauri packaging work. `large-v3` on CPU will be slow; `small` is the practical model choice for this path.