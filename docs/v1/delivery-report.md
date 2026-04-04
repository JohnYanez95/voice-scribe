# Voice Scribe v1 — Delivery Report

**Date:** April 3, 2026
**Author:** Johnraymond Yanez
**Status:** v1 Complete

---

## Executive Summary

Voice Scribe v1 has been delivered. The product is a local-first speech-to-text tool built for developer workflows. A user records speech in a browser UI, a GPU-accelerated containerized backend transcribes it locally using `faster-whisper`, and the transcript is returned to an editable text area for review and clipboard copy. No cloud services are involved at any point.

All five items in the v1 product scope were delivered:

1. Record one utterance
2. Send it to a local transcription API
3. Return transcript text
4. Display in an editable text area
5. Copy the result to clipboard

---

## What Was Built

### System Architecture

Voice Scribe is a two-service system communicating over localhost HTTP. The split is dictated by hardware constraints: browser APIs (microphone, clipboard) cannot run in a container; GPU inference cannot run efficiently in a browser.

```
[Host — Browser UI (localhost:5173)]
    Microphone → MediaRecorder → Audio Blob → POST /transcribe
                                                      ↓
[Docker Container — FastAPI (localhost:8000)]
    MIME Validation → ffmpeg transcode → faster-whisper inference → JSON response
                                                      ↓
[Host — Browser UI]
    Editable textarea → Clipboard copy
```

No WebSocket, no reverse proxy, no message queue. Plain HTTP over localhost only.

### Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | React, TypeScript, Vite | Browser mic access, clipboard, fast iteration |
| Backend | Python, FastAPI | Model ecosystem, easy containerization |
| STT Engine | faster-whisper (large-v3) | Accuracy/speed balance on local GPU |
| Transcoding | ffmpeg (in container) | Normalizes browser audio to 16 kHz mono WAV |
| Container | Docker, CUDA 12.6 | GPU isolation and reproducibility |

### Request Lifecycle

A single transcription passes through eight stages:

1. Browser records audio (`webm/opus` via `MediaRecorder`)
2. `POST /transcribe` (multipart/form-data)
3. MIME type and file size validation (rejected early, before I/O)
4. Upload written to temp file
5. ffmpeg transcode to 16 kHz mono WAV (30 s timeout)
6. faster-whisper inference (≤ 60 s audio)
7. Temp files deleted (guaranteed `try/finally` — both success and failure paths)
8. Transcript JSON returned to browser

---

## Services Delivered

### Backend (`apps/api/`)

- **FastAPI** application with `GET /health` and `POST /transcribe` endpoints
- **MIME validation** as a dedicated function (`validate_mime_type`) — accepts `audio/webm`, `audio/ogg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/mpeg`
- **ffmpeg transcoding** — all inputs normalized to 16 kHz mono WAV
- **faster-whisper inference** — `large-v3` model, CUDA, float16; CPU fallback with `small` + int8
- **Model loading** — singleton loaded once at startup via FastAPI lifespan, held in GPU memory
- **Temp file lifecycle** — `NamedTemporaryFile(delete=False)` inside `try/finally`; no bare `os.remove()`
- **Structured logging** — operational telemetry only (model load, transcode, inference — durations and formats, never content)
- **CORS** — allowlisted to `http://localhost:5173` and `http://127.0.0.1:5173` only
- **Request limits** — 10 MB upload cap, 60 s audio cap, one file per request

### Frontend (`apps/web/`)

- **React + TypeScript + Vite** application
- **`useRecorder` hook** — encapsulates `MediaRecorder` lifecycle; explicitly requests `audio/webm;codecs=opus`; runs `isTypeSupported()` pre-flight; assembles chunks into Blob on stop; releases mic on unmount
- **Five-state UI machine** — `idle → recording → processing → done → idle` (or `→ error → idle`); every transition triggered by user action or API response, never by timer
- **`api.ts` service layer** — typed `fetch()` calls to `localhost:8000` with error handling
- **Editable transcript textarea** — user can edit before copying
- **Clipboard copy** — `navigator.clipboard` with a dedicated copy button
- **Error handling** — codec unsupported, API failure, and network errors all surface as user-visible messages

### Infrastructure & Ops

- **Docker Compose** (`ops/docker/compose.dev.yml`) — GPU passthrough via `deploy.resources`, host-mounted model cache volume (`data/cache/`), host-mounted temp directory (`data/tmp/`)
- **Model caching** — `large-v3` (~3 GB) downloads once on first run to the host-mounted volume; survives container restarts
- **Makefile** — `make dev`, `make build`, `make test`, `make gpu-check`, `make api`, `make web`
- **GPU bootstrap script** (`ops/scripts/bootstrap_gpu_check.sh`) — pre-flight check; gates `make dev` behind GPU verification
- **Smoke test script** (`ops/scripts/smoke_test.sh`) — end-to-end curl test against the running API with a real audio file
- **CI workflow** (`.github/workflows/ci.yml`) — three jobs: frontend (typecheck + vitest), backend (pytest), Docker build

### Documentation

- `roadmap.md` — single source of truth for scope decisions; updated to v1 Complete
- `CLAUDE.md` — AI coding assistant guidance: commands, architecture map, hard requirements
- `docs/architecture.md`, `docs/gpu-setup.md`, `docs/privacy.md`, `docs/threat-model.md`, `docs/release-checklist.md`
- `docs/presentations/v1/main.tex` — LaTeX Beamer slide deck covering motivation, architecture, audio pipeline, frontend, security, and roadmap
- `.github/SECURITY.md`, `.github/dependabot.yml`
- `.env.example` — full environment variable reference

---

## Hard Requirements — Compliance Check

These were non-negotiable from the roadmap. Each was verified in the shipped code:

| Requirement | Status | Notes |
|---|---|---|
| Temp file cleanup via `try/finally` | Delivered | `NamedTemporaryFile(delete=False)` + `os.unlink()` in finally block |
| Never log transcript content or raw audio | Delivered | Logs contain durations, formats, detected language only |
| MIME validation as a separate function | Delivered | `validate_mime_type()` — magic-byte check is a one-line addition |
| CORS allowlist both localhost origins | Delivered | `localhost:5173` and `127.0.0.1:5173` |
| MediaRecorder explicit codec request + `isTypeSupported()` | Delivered | Hard gate — recording never starts on unsupported browsers |
| Request limits (60 s, 10 MB, one file) | Delivered | Enforced in backend before inference |
| Smoke test script in `ops/scripts/` | Delivered | `smoke_test.sh` + synthetic `test.mp3` |
| Operational logging with timestamps | Delivered | structlog, all six required events |
| GPU and CPU execution modes | Delivered | CUDA default; CPU/int8 fallback via `DEVICE` env var |

---

## Explicit Non-Goals (Held)

Nothing from this list was introduced:

- Continuous dictation
- Live streaming partial transcripts
- Multi-user deployment
- Async job queues / background workers
- Reverse proxy
- Desktop packaging (Tauri — roadmap v2)
- Grammar LLM integration

---

## Test Coverage

**Backend (pytest):**
- Health endpoint responses
- MIME type validation (accepted and rejected types)
- Codec parameter stripping from MIME strings
- File size rejection (> 10 MB)
- Missing file handling

**Frontend (vitest):**
- Record button state transitions
- Transcript textarea rendering
- Copy-to-clipboard action
- Loading state display
- Text edit callback

**Integration:**
- Smoke test script (`ops/scripts/smoke_test.sh`) — `GET /health` and `POST /transcribe` against the running API with a real audio file

**CI:** All three jobs (frontend, backend, Docker build) run on push and pull request to `main`.

---

## Security Posture

- API binds to `localhost:8000` — not network-accessible
- CORS restricted to two explicit localhost origins, no wildcard
- Audio temp files deleted by `finally` block on both success and failure
- No transcript content or raw audio in logs at any level
- Secrets excluded from repo; `.env.example` only
- Dependabot configured for weekly dependency scans
- Container runs as non-root user (UID/GID from host)

---

## Known Limitations and Forward Context

These are understood constraints, not defects:

- **Synchronous inference** — `faster-whisper` blocks the Python thread during inference. Correct for a single-user local tool. Future rework path: `asyncio.to_thread()` or background task with polling (changes API contract).
- **Chrome on Windows only (v1 supported browser)** — `MediaRecorder` codec behavior varies across browsers. Other browsers may work but are untested.
- **CPU path untested end-to-end** — Fallback is wired (`DEVICE=cpu`, `int8`) but has not been exercised in a full session. Practical model for CPU: `small`.
- **Single `docker compose up` starts API only** — frontend requires a separate `make web`. Adding frontend as a second Compose service is noted in the post-v2 parking lot.

---

## What Comes Next

**v1.1** (priority order)

1. `clean_transcript(raw: str) -> str` — single pure function in `apps/api/services/`. Rule-based only: whitespace normalization, punctuation, capitalization, repeated-word removal. No config, no toggles. API response returns both `raw` and `cleaned` fields for side-by-side quality evaluation. Run against real dictation for one week before deciding what needs to be configurable.
2. ~~**Extend state machine diagram**~~ — *superseded: no new UI states were introduced by item 1. Removed from v1.1 scope. Diagram updates gate on v2.0 settings panel instead.*
3. ~~**Settings UI**~~ — *superseded: original motivation (cleanup toggles) eliminated by item 1 evaluation. Moved to v2.0 with concrete content (recording mode, model selection).*
4. ~~**Retention controls**~~ — *superseded: the system has no server-side persistence and the security posture prohibits it. Removed from scope — not deferred, removed. See roadmap for rationale.*

**v2**
- Desktop packaging (Tauri)
- Global hotkeys
- Session history
- Smarter silence detection / voice activity detection
- Optional streaming mode (requires WebSocket transport)

Full post-v2 ideas are tracked in `roadmap.md` under the parking lot section.

---

## Feedback & Takeaways

*Source: PM, Principal, and Senior review of this report — April 3, 2026*

### v1 Close-Out Item (Not v1.1 Backlog)

The CPU fallback path is wired but has not been exercised end-to-end. **Before any v1.1 work begins:** run `smoke_test.sh` with `DEVICE=cpu` and `WHISPER_MODEL=small`, confirm a transcript is returned, and record the wall-clock latency in a comment at the top of `ops/scripts/smoke_test.sh`. Budget ~30 minutes. This retires the one remaining open thread in v1.

### Process Standards

- **This report format is now the milestone template.** The hard-requirements compliance table is the most valuable section — it makes review fast and auditable. Every future milestone delivery (v1.1, v2) should use the same structure.
- **Add an actual timeline section.** The roadmap estimated ~8 days of phased work. Knowing where time actually went — especially if environment setup consumed more than expected — is useful context for scoping subsequent milestones. If v1 data exists, add it retroactively. If not, start tracking now so v1.1 has it.

### Pattern to Repeat

The pre-kickoff design review surfaced risks that all landed as solved problems in this report: temp file handling, CORS origin variants, model cache persistence, and codec negotiation. That is what a design review is supposed to produce. Repeat this cycle for v1.1 — surface risks early, retire them in execution.

### Reviewer Quotes

**PM:** *"Clean delivery. Every hard requirement from the roadmap is accounted for, scope was held exactly where it was drawn, and nothing speculative crept in. That's discipline."*

**Principal:** *"The team internalized the constraints as engineering standards, not as a checklist to satisfy. That's the part that matters most."*

**Senior:** *"The pre-kickoff concerns that were raised — temp file handling, CORS variants, cache persistence, codec negotiation — all landed as solved problems in the delivery report. That's the outcome a design review is supposed to produce."*

### Presentation Feedback — Principal (April 3, 2026)

> *"The slide deck isn't just documentation — it's a thinking artifact. The fact that every architectural decision has a corresponding diagram that matches the delivery report tells me the team understood the system at the level they needed to before writing code."*

**Specific callouts:**

- **Privacy data flow diagram** — identified as the single most useful slide. Traces every piece of sensitive data from creation to deletion with color-coded sensitivity levels and an explicit deletion point. Keep this diagram updated as the system evolves; it rots fast once people stop maintaining it.
- **State machine diagram** — clean and correct. Five states, deterministic transitions, both terminal states loop back to idle. When v1.1 adds settings or cleanup toggles, extend this diagram *before* writing the component code.
- **GPU passthrough slide** — the `v591+` driver callout is useful specificity, but should be pinned to the version actually validated against with a validation date. "v591+" will mean something different six months from now.
- **Deck structure** — the progression from principles → architecture → pipeline → security reads like a proof; each section builds on the prior one with no circular dependencies.

**Standing instruction:** Keep the deck in the repo. It's a better onboarding document than most READMEs.

### Presentation Feedback — PM (April 3, 2026)

> *"This is unusually rigorous for a v1 internal presentation. The TikZ diagrams aren't decoration — they're specifications that happen to be visual."*

**Specific callouts:**

- **Request lifecycle diagram** — does double duty as an error budget map. The color-coded stages (validation → processing → cleanup) with annotated limits (10 MB, 30 s timeout, 60 s audio) let anyone trace where a failure will be caught without reading prose. The kind of diagram that saves a debugging session six months from now.
- **Model caching diagram** — the "first run only" dashed arrow from HuggingFace versus the persistent bidirectional volume mount makes the expected behavior unambiguous. The senior called out cache permission issues as a real setup risk; this diagram retires that ambiguity.
- **Driver version pin** — same note as the principal: `v591+` will age poorly. Update to `v591+ (validated against vXXX on YYYY-MM-DD)` before the deck is used for onboarding.
- **CPU path gap in the deck** — the delivery report lists CPU as a known limitation (wired, untested). If the deck is the onboarding document, it should say so. A single bullet on the inference slide noting the fallback is unvalidated prevents a new contributor from assuming it's production-ready. *(Addressed: bullet added to inference slide.)*
