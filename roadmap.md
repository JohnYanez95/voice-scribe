# Voice Scribe — Roadmap

**Last Updated:** August 1, 2026
**Status:** v4.0 implemented, peer-reviewed, and field-tested (2026-08-01); v4.1 next

---

## What This Document Is

This is the single source of truth for building Voice Scribe. It consolidates the original design spec, review feedback, and execution directives into one reference. If something in this document contradicts an earlier draft, this document wins.

---

## Product Summary

Voice Scribe is a local-first speech-to-text **primitive** — a building block for voice-driven workflows, not a finished product. The goal is a standalone application that users can configure, embed, and compose with other tools.

Two convergent use cases drive the design:

1. **Developer productivity** — hands-free coding workflow. Speak prompts and thoughts into Claude Code, terminals, IDEs, or any text input. No typing, no context switching.
2. **Language learning** — pronunciation practice and conversational tutoring in foreign languages (Japanese is the primary target). Voice Scribe provides the STT foundation; separate TTS and language tutor projects compose on top (see Adjacent Projects).

Both use cases demand the same underlying capabilities: accurate multilingual transcription, low-latency response, composable output, and eventually bidirectional voice interaction.

**v1 scope was intentionally narrow:** record one utterance, send to a local transcription API, return transcript text, show in an editable text area, copy to clipboard. That scope has been delivered and validated.

**Voice Scribe is the capture layer.** It does raw speech capture, transcription, and immediate delivery well — and stops there. Transformation, structuring, audience routing, and performance instrumentation are separate products that compose with Voice Scribe, not extensions of it. This boundary is compliance-driven: Voice Scribe's security and privacy posture is built around zero persistence and zero metadata collection. Products that need to collect timing data, route artifacts, or store derived content bear their own compliance cost. See Adjacent Projects for the downstream product landscape.

---

## Design Principles

**Local-first.** Audio and transcripts stay on the user's machine. No cloud services required.

**Host for interaction, container for inference.** The browser owns mic access, clipboard, and editing. The container owns model loading and inference.

**Audio is transient, text is durable.** Raw audio is short-lived input. Transcripts are the user-facing artifact.

**Scope matches the milestone.** Repo structure and services reflect current reality, not future aspirations.

**Public-safe defaults.** The repo and runtime assume eventual public distribution and default toward safe behavior.

**Close-mic audio source assumed.** VAD accuracy and inference quality degrade with distant or ambient-noise-contaminated input. A headset or USB microphone is recommended in any environment with background noise. Laptop microphone is viable in quiet single-speaker conditions only.

**Raw transcript is first-class.** The raw transcript pane is the primary product surface — a scratchpad, an editing surface, and a staging area for downstream tools. Voice Scribe does not transform, summarize, or route text. It captures and presents. (Distinct from "audio is transient" — audio is the short-lived input; the raw transcript is the durable, editable output.)

**Auditory confirmation is an interaction primitive.** Sound cues communicate action success without requiring visual focus. Part of the recording/command interaction loop, not a notification system.

---

## Architecture

```text
[Browser UI on host]
    ├─ record audio (MediaRecorder or PCM fallback)
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

The frontend runs on the host at `localhost:5173` (Vite). The API runs in a Docker container at `localhost:8000` (FastAPI). v1/v1.1 architecture: plain HTTP over localhost. No WebSockets, no reverse proxy, no queue. v2.1 introduces WebSocket transport — see milestone section.

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

The browser `MediaRecorder` produces encoded audio (typically `webm/opus`, negotiated at
runtime). When `MediaRecorder` has no working encoder (e.g., broken GStreamer on WebKitGTK),
`useRecorder.ts` falls back to raw PCM capture via `ScriptProcessorNode` and encodes to WAV
in JavaScript — the same approach continuous mode already uses. The backend accepts both
paths. Transcoding happens server-side, not in the frontend.

Accepted inputs: `audio/webm`, `audio/ogg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/mpeg`.

Normalized internal format: mono 16kHz WAV via `ffmpeg`.

**Codec negotiation (evolved from v1 codec note):** `MediaRecorder` doesn't guarantee `webm/opus` on every browser or runtime. `useRecorder.ts` negotiates from a prioritized list (`audio/webm;codecs=opus`, `audio/ogg;codecs=opus`, `audio/webm`, `audio/ogg`) via `isTypeSupported()`. If no format is supported — as happens on WebKitGTK when GStreamer's encoding pipeline fails to initialize — the hook falls back to `ScriptProcessorNode` raw PCM capture, encoding to WAV client-side via `encodeWav()`. The WebSocket endpoint accepts an `audio_format` query parameter so temp file suffixes match the actual container; ffmpeg probes magic bytes regardless.

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
2. Frontend captures audio via `MediaRecorder` (negotiated codec) or `ScriptProcessorNode` PCM fallback
3. If neither capture path works, show a clear error message
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
│  ├─ diagrams/                            # Living Mermaid .mmd sources
│  │  └─ state-machine.mmd
│  ├─ v1/                                  # Frozen v1 artifacts
│  │  ├─ delivery-report.md
│  │  └─ presentation/
│  │     ├─ main.tex
│  │     └─ main.pdf
│  ├─ v2/                                  # Living v2 artifacts
│  │  └─ presentation/
│  │     ├─ main.tex                       # Living onboarding document
│  │     ├─ main.pdf
│  │     └─ images/                        # Rendered Mermaid PNGs
│  ├─ architecture.md
│  ├─ docker-setup.md
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

**Audio/data handling:** Audio is transient by design — deleted in the `finally` block immediately after processing. No transcripts are stored server-side. This is the retention behavior. Use dedicated temp directories only.

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

**v1 close-out item (completed 2026-04-03):** CPU smoke test run with `DEVICE=cpu` and `WHISPER_MODEL=small`. Transcript returned successfully. Wall-clock latency (~1.87s) recorded at top of `ops/scripts/smoke_test.sh`.

### v1.1 (complete)

**Sole deliverable:** `clean_transcript(raw: str) -> str` — minimal cleanup function in `apps/api/services/cleanup.py`. The `/transcribe` response returns both `raw` and `cleaned` fields. A side-by-side comparison view in the frontend was built to support evaluation and retained post-evaluation (see note below).

**Evaluation outcome (2026-04-03):** Whisper large-v3 already handles punctuation, capitalization, and filler suppression on short clean audio. The full rule set evaluated (punctuation spacing, duplicate removal, post-sentence capitalization) solved problems that don't exist for this use case. Function stripped to two rules: whitespace normalization and first-letter capitalization. VAD filtering (`vad_filter=True`) enabled for hallucination prevention. A second cleanup model (LLM or GEC) was evaluated and rejected — the risk of mangling technical content outweighs the marginal quality gain over Whisper's native output.

**Removed items (not deferred — removed from scope):**

- **Retention controls** — removed. The system has no server-side persistence. Audio is deleted in the `finally` block. Transcripts exist only in React state and vanish on page refresh. The security posture actively prohibits persistence. There is nothing to configure. This is not a deferral — there is no valid use case. Do not re-introduce unless a concrete requirement for persistence emerges.

- **State machine diagram update** — removed. Exists to cover new UI states. v1.1 introduced no new states. No-op.

- **Settings panel** — removed from v1.1. The original motivation (cleanup toggles) was eliminated by the evaluation finding. The settings panel has real content in v2 (recording mode, model selection) and belongs there.

**Evaluation tooling retained intentionally:** The comparison view in `Transcript.tsx` (lines 43–58) was built for the cleanup evaluation. It is gated on `rawText !== text`, which is true only when whitespace normalization or first-letter cap actually fires. Low render frequency, lightweight code. Retained because it will be useful if the cleanup function grows later. Not orphaned code.

**A second GPU-backed model for cleanup** is deferred — evaluated and found unnecessary for this use case. This idea is now subsumed by the Voice Workspace product's second-stage cleanup model (see Adjacent Projects). Revisit within Voice Scribe only if Whisper output quality degrades on longer recordings or non-English dictation.

### v2 — Interaction Model

Build on the web app first. Prove the interaction patterns in the browser before packaging as a desktop app. The web app is the fastest iteration loop, and the architecture transfers to Tauri.

Broken into sequenced sub-milestones. Each builds on the prior one.

#### v2.0 — Hotkeys + Settings Panel (complete, 2026-04-04)

- **Hotkey system** — `Ctrl+Shift+Space` (record), `Ctrl+Shift+Y` (copy), `Ctrl+Shift+X` (clear), `Ctrl+Shift+S` (settings). Bindings chosen to avoid Chrome built-in conflicts. Record hotkey is a no-op while settings panel is open.
- **Settings panel** — model selection: swap between models declared in `WHISPER_AVAILABLE_MODELS` at runtime. Backend: `GET /models`, `POST /models/swap` with threading lock and VRAM cleanup. Swap endpoint is regular `def` (not `async def`) to keep the event loop alive. Frontend: slide-out panel with loading/success/error states, record button disabled during swap. Fetch failure shows error with retry.
- **State machine diagram** — updated in v2 Beamer deck. Settings is an orthogonal `settingsOpen: boolean`, not a sixth `RecordingState` value. Migrated to Mermaid; TikZ retained for spatial/precision diagrams.
- **Recorder refactor** — `useRecorder` lifted from Recorder to App for hotkey access. Recorder simplified to presentational component.

#### v2.1 — Streaming + VAD (complete, 2026-04-04)

One milestone, one API contract change. The biggest architectural change in the project.

- **Streaming transcription** — WebSocket transport supplements (not replaces) the HTTP POST endpoint. Deliberate decision: the HTTP endpoint is mature, fully tested, and the natural automatic fallback if the WebSocket connection fails — removing it gains nothing. Streaming is the v2.1 default for the live path. The user sees words appearing as segments complete; faster-whisper's segment-by-segment output is streamed to the frontend as each segment finishes.
- **State machine diagram** — updated before any streaming component code is written, per project discipline. New user-visible states at minimum: WebSocket connecting (post-stop, pre-first-segment, independent failure mode from inference) and segments-receiving (partial transcript visible, no spinner). Whether these become new `RecordingState` enum values or named sub-states within `processing` is the diagram's decision to make — not the implementation's.
- **VAD** — `vad_filter=True` is already active and complete for push-to-talk. Silero VAD runs inside `model.transcribe()`, identifies speech windows on CPU, and prevents the Whisper encoder/decoder from touching silence. No new server-side VAD code is required for v2.1. Client-side VAD (browser-side, required for continuous mode) remains the v2.2 pre-condition.

#### v2.2 — Continuous Mode + Segmentation (complete, 2026-04-04)

Builds on v2.1 streaming and VAD.

**Pre-condition (gate, not suggestion):** v2.2 does not ship without client-side VAD in place. Continuous mode keeps the mic open indefinitely. Without a client-side gate deciding "this is speech" before audio is sent, the backend processes ambient room audio continuously — GPU saturation by design. `@ricky0123/vad-web` (Silero VAD v4, ONNX/WASM, CPU-only, ~400KB) is the baseline. Energy thresholding is not sufficient — it cannot distinguish speech from background noise and fails on quiet speakers. This library must be integrated and validated against real ambient conditions before any continuous mode code ships.

- **Continuous recording mode** — mic stays open. Client-side VAD detects speech onset and offset. Speech frames are sent; silence is discarded at the source. Transcription streams as the user talks. Accumulates until explicit reset.
- **Segmentation mechanisms** (all may coexist):
  1. Silence-based paragraph breaks — extended silence inserts a visual break. Automatic, passive.
  2. Hotkey reset — keyboard shortcut for "that thought is done, start fresh below." Manual, explicit.
- **Recording mode toggle** added to the settings panel (introduced in v2.0) in this milestone. Push-to-talk vs continuous is now user-selectable.

#### v2.3 — Voice Command Vocabulary

Lightweight implementation. Needs continuous mode (v2.2) to be meaningful.

- A small set of key phrases that form a control language within the voice stream:
  - **Stop** — halt recording
  - **Submit** — deliver current transcript to clipboard
  - **Redo** — discard current transcript, start fresh
  - **Clear** — reset the transcript buffer
- All implemented as lightweight string matches on incoming segments, stripped from output before display.
- **Ship with fixed phrases first.** Evaluate for false positives in real dictation before adding configurability. Phrase customization is a future settings addition, not a v2.3 requirement.
- Phrases must be phonetically distinctive, semantically absurd in a developer context, and resistant to false positives.

### Gate 1 — Phrase Validation
Date: 2026-04-04  |  Model: large-v3  |  Ambient: quiet (user throat condition noted)

| Phrase         | Confirmed | Variance observed                                                    |
|----------------|-----------|----------------------------------------------------------------------|
| scribe stop    | 8/8       | none                                                                 |
| scribe submit  | 5/5       | none                                                                 |
| scribe redo    | 1/1       | light coverage                                                       |
| scribe clear   | 6/8       | "Subscribe clear.", "It's quite clear." under rushed/scratchy speech |

Verdict: confirmed — "scribe" prefix viable. False negatives only under adverse speech conditions (no
misfires observed). Rushing + throat condition degrades "scribe clear" recognition; clean speech is
consistent. Pausing mid-phrase causes VAD to split utterance into separate segments — neither matches a
command (accepted; user must speak the full phrase in one breath). Proceed with implementation.

**Post-delivery finding (2026-04-04):** The "speak in one breath" constraint proved too demanding in
field use. VAD-split was observed and accepted in Gate 1 — the gap was in the acceptance criterion, not
the detection. Field use invalidated the criterion. This distinction is the basis for the v2.3.1 gate
expansion (see below).

#### v2.3.1 — Voice Command Vocabulary Redesign

**Scope (PM, 2026-04-04):**
In scope: three single-word commands, one-table update in `voiceCommands.ts`, test update, presentation
update. No architectural changes, no new dependencies, no backend changes.
Out of scope (not deferred — out): prefix model, stop command, submit command, configurability.

**Principal decision (2026-04-04): Option A — single-word vocabulary, same architecture.**
Detection pipeline, `COMMAND_MAP`, and `onComplete` integration point unchanged. Only the keys move.
Option B deferred to v3/Tauri. Option C rejected.

**Vocabulary — locked (2026-04-04), revised (2026-04-04):**

| Word | Action | Replaces |
|---|---|---|
| copy | Write transcript to clipboard | "scribe submit" |
| clear | Clear transcript buffer | "scribe clear" / "scribe redo" |

**"break" dropped before implementation (Gate 1 finding, 2026-04-04):** "break" was in the original
locked vocabulary but removed after Gate 1 Test 1. Reason: (1) highest false-positive risk of the three
words — "break" is core programming vocabulary that appears constantly in developer dictation; (2) the
use case is already covered — automatic paragraph gaps via `lastSegmentTimestampRef` handle paragraph
separation in continuous mode. No gap left by the removal.

**Principal — VAD-split risk reversal (2026-04-04):**
The failure direction reverses with single-word commands. In v2.3, VAD splitting caused false negatives —
"scribe stop" split into two segments, neither matched, command didn't fire. With single-word commands,
VAD splitting becomes a false positive vector: a compound phrase pauses mid-utterance, the first word
becomes an isolated segment, and it matches. "Break out of the loop" splits after "break" — fires.
"Clear the cache" splits after "clear" — fires.

This mechanism is what Gate 1 Test 2 is stress-testing (live continuous-mode sentences, not text
analysis). The Principal named it to ensure the gate knows what it's looking for.

**Principal — severity asymmetry:**
Not all false positive failures are equal. Gate tolerance for "clear" must be stricter than for the
others. "Break" fires accidentally → inserts `\n\n` → recoverable (backspace). "Copy" fires accidentally
→ overwrites clipboard → benign (transcript still present). "Clear" fires accidentally → destroys the
buffer → work is lost, unrecoverable. If "clear" shows any false positives under gate conditions, change
the word. "Break" and "copy" have more tolerance.

**Gate 1 — two tests, one session (PM, 2026-04-04):**

*Test 1 — Fidelity (false negative check):* Speak each word 10× in continuous mode under normal and
adverse conditions (natural cadence, tired voice). Target ≥9/10 per word. Adverse conditions are the
bar.

*Test 2 — Exact-segment guard (false positive check):* Speak 5–10 sentences in continuous mode where
"copy," "clear," and "break" appear as non-standalone uses — "copy that function," "let me clear this
up," "we need a break in the logic." Live VAD test, not text analysis. Confirm zero commands fire.
"Clear" requires zero tolerance. Any false positive on "clear" fails the vocabulary, not just the gate
run.

Record in roadmap.md as "Gate 1 — v2.3.1 Phrase Validation": date, model, ambient, per-word fidelity
counts, false-positive sentence count, verdict. Same format as v2.3 gate.

If both tests pass — ship. No additional review required (PM).

**Verification checklist addition (PM):** The v2.3 presentation slide command table (four rows: scribe
stop / submit / redo / clear) must be updated to the new vocabulary (three rows: copy / clear / break).
Same file, same session. Do not let it slip.

**Process:** Gate 1 → one table update + test update + presentation update → ship.

### Gate 1 — v2.3.1 Phrase Validation
Date: 2026-04-04  |  Model: large-v3  |  Ambient: standard

Test 1 — Fidelity
| Word  | Confirmed | Variance |
|-------|-----------|----------|
| copy  | 10/10     | none     |
| clear | 9/10      | none     |
| break | dropped   | High false-positive risk; automatic paragraph breaks cover the use case — removed before completion |

Test 2 — False positive field test
Relocated to post-implementation manual verification. Requires new vocabulary active to be meaningful —
confirming "clear the cache" doesn't fire a "clear" command is only valid once "clear" is a registered
command. The gate protected transcription fidelity; false-positive validation follows implementation.

Verdict: confirmed — two-word vocabulary (copy, clear) viable. Proceed with implementation.

#### v2.3.2 — Remove Ctrl+Shift+R Hotkey

**Scope:** Remove the manual paragraph break hotkey. The automatic paragraph gap (3s silence →
`\n\n`) covers the use case. A dedicated hotkey for paragraph insertion is not worth the surface
area.

**Changes (2026-04-04):**
- `useHotkeys.ts` — removed `onParagraphBreak` from interface, removed `"R"` key binding
- `App.tsx` — removed `handleParagraphBreak` callback and from `hotkeyHandlers`; removed hint from UI bar
- `App.test.tsx` — removed paragraph break describe block (2 tests)
- `docs/v2/presentation/main.tex` — removed Ctrl+Shift+R row from hotkey table; updated roadmap detail and Detection Architecture slide

Hotkey system is now 4 bindings: Space (record), Y (copy), X (clear), S (settings).

#### v2.3.3 — Paragraph Break Timing Fix

**Problem:** `PARAGRAPH_BREAK_MS` threshold was measured between `onComplete` callbacks, which
include GPU inference latency. On slow hardware or CPU inference, every consecutive utterance exceeds
3 seconds between completions — every segment becomes a paragraph break regardless of actual pause
length. Principal decision: fix before v3, which broadens the hardware profile.

**Fix:** Capture `Date.now()` at `onSpeechEnd` (before inference starts) and thread it through
`triggerTranscription` as `speechEndTime`. The paragraph break comparison and `lastSegmentTimestampRef`
update both use `speechEndTime` instead of `Date.now()`. Elapsed now measures time between when the
user spoke, not between when the GPU finished.

**Changes (2026-04-04):**
- `App.tsx` — `triggerTranscription` gains optional `speechEndTime?: number` parameter; paragraph
  break elapsed uses `speechEndTime`; `lastSegmentTimestampRef` stores speech-end time; `onSpeechEnd`
  captures and passes `Date.now()` before encoding

Push-to-talk path unaffected (`speechEndTime` is undefined for PTT; `append=false` gates all paragraph
break logic). 66/66 tests green.

### v3 — Desktop Application (Tauri)

v3 closes the delivery gap the browser cannot close. The clipboard-focus limitation
(`navigator.clipboard.writeText` requires document focus) is a platform ceiling, not a missing
feature. Mic access is OS-level — VAD and recording work cross-window. Clipboard write is gated on
window focus. The full loop (speak → transcribe → deliver to where you're working) is broken at the
last step in browser mode. v3 is a platform change that completes the loop.

Direct injection (transcript delivered to the focused application without manual paste) is the
Tauri-only power feature — it requires native OS access the browser cannot provide.

**Locked architectural decisions (Principal, 2026-04-04):**

- **Tauri v2** — locked. Plugins: `@tauri-apps/plugin-global-shortcut` (v3.3),
  `@tauri-apps/plugin-shell` (sidecar), tray via `tauri::tray`. Clipboard uses HTTP server
  (`tiny_http` + `arboard` on port 8001), not the Tauri clipboard plugin — plugin crashes
  WebKitGTK without user activation (see progress report Triage #6). Rust side uses Tauri v2 API
  (`tauri::Builder`, `tauri::AppHandle`). v1 plugins are not forward-compatible; this is not
  revisitable.

- **Repo structure** — monorepo. `apps/desktop/` alongside `apps/web/` and `apps/api/`. The API
  backend is shared. Tauri points its dev server at Vite (`apps/web/`) and its build at Vite's output.
  `apps/desktop/` contains Tauri configuration (`tauri.conf.json`, `src-tauri/`) and Rust-side code
  only — not a copy of the frontend. No component forks. Capability differences (native clipboard,
  direct injection) live in the service layer via a single `platform.ts` module — not in components,
  not in a parallel `desktop-api.ts`. The moment you have two copies of a component or two parallel
  service files, you have two maintenance surfaces that will diverge silently.

- **Backend** — Python sidecar. Tauri spawns the existing `apps/api/` Python backend as a managed
  child process. No Docker, no container overhead. faster-whisper is proven; rewriting inference in
  Rust simultaneously with building the Tauri shell is scope explosion. Rust-native inference is a
  named future milestone ("v4 or v3.x — single-binary distribution") with a stated trigger: *revisit
  when distribution to non-developer users becomes a requirement.* whisper.cpp is the candidate when
  that time comes, not candle.

- **wsCleanupRef** — hard requirement before Tauri ships. In the browser, the SPA never navigates so
  orphaned connections don't materialize. In Tauri, the webview persists and "close the panel" is real
  component unmount. The current single-ref pattern must be replaced with a `Set<() => void>` (register
  on open, deregister on close, iterate on unmount). Ships as a standalone PR on main before any Tauri
  code exists — web-side refactor with full test coverage, not mixed into the Tauri scaffolding.
  **Complete (2026-04-05, `8cbc933`).** Set pattern shipped with deregister-on-completion. 68
  frontend tests.

- **Voice command surface** — two shipped commands: `copy` (clipboard write, native API removes focus
  requirement), `clear` (buffer wipe, carried from v2). `submit` (direct injection into focused
  application) is deferred — WSL2 runs Linux/WebKitGTK, `SendInput` is Win32 with no path into the
  Linux process namespace. The `submitText()` stub remains in `platform.ts`; the architectural
  separation between `copy` and `submit` is preserved as a locked decision (clipboard write is safe
  and predictable; injection requires focus to be correct and must be opted into deliberately).
  Re-evaluation trigger: Windows-native Tauri build. Specific words subject to gate evaluation; the
  command separation is non-negotiable.

- **Port management** — fixed port, fail loudly. The sidecar binds to port 8000. If 8000 is occupied,
  the sidecar fails to start and Tauri surfaces a user-visible error. `api.ts` hardcodes
  `http://localhost:8000` and `ws://localhost:8000` — no dynamic port discovery, no IPC port
  communication. Correct for a single-user tool where the user controls their own machine.

- **Single build artifact** — runtime platform detection (`window.__TAURI__`), not build-time flags.
  One Vite build serves both the browser and the Tauri webview. `@tauri-apps/` packages imported via
  dynamic `import()` so the browser build produces zero import errors. `vite.config.ts` excludes
  Tauri packages from dependency pre-bundling via `optimizeDeps.exclude`.

- **Same UI** — recording modes, streaming, VAD, voice commands, settings panel.
- **System tray** — app runs in background, accessible via global hotkey from any application.
- **Global hotkeys** — trigger recording from any application, not just when Voice Scribe is focused.
- **Model management** — model download, selection, and caching without editing config files. Deferred
  to v3.x — the existing settings panel handles runtime model swap; download progress and cache
  management are not load-bearing for v3.0–v3.3.

#### Prerequisites (before v3.0 implementation begins)

**Prereq 1 — wsCleanupRef refactor (complete, 2026-04-05, `8cbc933`).** `wsCleanupRef` replaced with
`wsCleanupSetRef` (`useRef<Set<() => void>>`). Completed connections deregister via `deregister?.()` in
`onComplete`, `onConnectionError`, and `onApplicationError` callbacks — Set does not grow unboundedly
during long continuous sessions. Unmount iterates the Set and calls every in-flight cleanup. Two new
tests: multi-segment cleanup on unmount, and stale-entry deregistration after natural completion. 68
frontend tests. Shipped on main before any Tauri code exists — isolation requirement held.

**Prereq 2 — Host environment validation (in progress).**
- ~~Config defaults~~ **(complete, 2026-04-05, `8cbc933`):** `config.py` defaults updated for host
  operation — `MODEL_CACHE_DIR` defaults to `~/.cache/voice-scribe`, `TEMP_DIR` defaults to
  `tempfile.gettempdir() + "/voice-scribe"`. Docker Compose overrides via env vars; `make dev`
  unchanged.
- ~~Bare-host startup validation~~ **(complete, exercised during Phase B triage):** GPU inference
  confirmed on bare host via Tauri sidecar. `/health` returns `"device": "gpu"`, model loads from
  `~/.cache/voice-scribe`. `nvidia-cublas-cu12` pip package required for `libcublas.so.12`;
  `cuda_ld_library_path()` in `main.rs` injects the library path at sidecar spawn time.
- **Host setup documentation** — pending. Close condition: `docs/v3/host-setup.md` that gets a fresh
  WSL instance to a running API without Docker.

#### v3.0 — Tauri Shell + Sidecar Lifecycle

**Deliverable:** Tauri app launches, spawns the Python API as a sidecar, webview loads the existing
Vite frontend, all existing functionality works identically to the browser version (push-to-talk,
continuous mode, voice commands, settings).

**Scope:**

1. **`apps/desktop/` scaffolding.** `tauri.conf.json`, `src-tauri/` with Cargo project, Tauri v2 CLI
   integration. Dev server points at `http://localhost:5173`. Build points at `apps/web/dist/`.

2. **Sidecar management in Rust.** Tauri's `shell` plugin spawns
   `uvicorn app.main:app --host 127.0.0.1 --port 8000` from `apps/api/`. Must handle:
   - Startup wait (health poll until `/health` returns 200)
   - Graceful shutdown (SIGTERM on app close, SIGKILL after timeout)
   - Crash detection and error surface to the user
   - Port conflict: port 8000 occupied → user-visible error dialog, no silent fallback

3. **API configuration for Tauri context.** ~~`config.py` defaults updated for host operation~~
   **(complete, Prereq 2):** `MODEL_CACHE_DIR` → `~/.cache/voice-scribe`, `TEMP_DIR` →
   `tempfile.gettempdir() + "/voice-scribe"`. Docker Compose overrides unchanged.
   - ~~`CORS_ORIGINS` must include the Tauri webview origin~~ **(complete, Phase B):**
     `config.py` default `CORS_ORIGINS` now includes all four origins: `http://localhost:5173`,
     `http://127.0.0.1:5173`, `https://tauri.localhost` (Windows/WSL2), `tauri://localhost` (Linux).
     Both `main.py` CORS middleware and `transcribe_ws.py` WebSocket origin check read from
     `settings.cors_origins` — one default update covers both surfaces.

4. **WebSocket origin enforcement.** `transcribe_ws.py` line 40 and `main.py` line 44 both read from
   `settings.cors_origins`. A single `CORS_ORIGINS` config update covers both surfaces. The gate must
   explicitly verify WebSocket streaming from the Tauri webview — not just HTTP health checks. Without
   this, the gate can pass on the HTTP fallback path while the primary transport is silently rejected
   with a 4003 close.

5. **Makefile update.** `make desktop` target starts the sidecar + Tauri dev mode. Existing
   `make dev` (Docker + Vite) stays untouched.

6. **WebKitGTK media permissions (triage addition).** WebKitGTK has a two-layer permission model
   for `getUserMedia`: a feature gate (`enable-media-stream`) and a runtime permission grant via the
   `permission-request` signal. Without both layers, recording is silently denied — `getUserMedia`
   rejects with `NotAllowedError`, no prompt, no WebKitGTK-level error. `main.rs` connects
   `connect_permission_request` and auto-grants all permission requests. Safe for a local-first tool
   with no untrusted content. Dependency: `webkit2gtk = "2.0"` in `Cargo.toml`.

7. **CUDA runtime discovery for bare-host GPU inference (triage addition).** `ctranslate2` dlopens
   `libcublas.so.12` at inference time. In Docker, the NVIDIA container runtime provides it. On bare
   host, it is missing unless explicitly installed. `pip install nvidia-cublas-cu12` provides the
   library under `site-packages/nvidia/cublas/lib/`. `main.rs` includes `cuda_ld_library_path()` which
   discovers pip-installed NVIDIA libraries under `site-packages/nvidia/*/lib/` and injects them via
   `LD_LIBRARY_PATH` on the sidecar child process. The function queries
   `site.getusersitepackages()` — user-scope pip installations only.

**Not in v3.0:** Native clipboard, `submit` command, global hotkeys, system tray. The app is a Tauri
wrapper around the existing web app with a managed backend. No new capabilities.

**Gate:** App launches. Record → transcribe → display works via WebSocket streaming through the Tauri
webview. HTTP fallback also verified. Settings panel works. Close app → sidecar process is gone (no
orphan `uvicorn` process). Relaunch works clean. Both transport paths exercise the Tauri origin.

#### v3.1 — Service Layer Split + Native Clipboard

**Deliverable:** `copy` voice command and Ctrl+Shift+Y hotkey use native OS clipboard (no focus
requirement). Web version unchanged.

**Scope:**

1. **Platform abstraction layer.** `platform.ts` module with three exports:
   - `isDesktop(): boolean` — checks `window.__TAURI__`
   - `writeClipboard(text: string): Promise<void>` — Tauri: `fetch()` POST to
     `http://127.0.0.1:8001/clipboard` (plain text body); browser:
     `navigator.clipboard.writeText()`
   - `submitText(text: string): Promise<void>` — stub in v3.1, calls `writeClipboard()` in both
     environments. Remains a stub — submit deferred indefinitely from Voice Scribe (see Deferred
     from v3).

2. **HTTP clipboard server.** `main.rs` spawns a `tiny_http` listener on `127.0.0.1:8001` during
   Tauri `setup()`. Accepts `POST /clipboard` with plain text body, writes to system clipboard via
   `arboard::Clipboard::set_text()`, returns 204. CORS allows `http://localhost:5173` (dev mode
   origin). `tauri.conf.json` CSP `connect-src` includes `http://127.0.0.1:8001`. The Tauri clipboard
   plugin (`tauri-plugin-clipboard-manager`) was tested and rejected — it crashes WebKitGTK with a
   `NeedDebuggerBreak` trap when called without user activation (voice commands fire from WebSocket
   callbacks, no user gesture). See progress report Triage #6.

3. **Clipboard call site routing.** Two call sites in App.tsx route through `platform.writeClipboard()`:
   - `case "copy"` voice command: `platform.writeClipboard(transcriptRef.current)`
   - `handleCopyTranscript`: `platform.writeClipboard(transcript)`
   - Both keep the existing `.catch(() => {})` fire-and-forget contract.
   - The third call site — "Copy to Clipboard" button in `Transcript.tsx` — remains on
     `navigator.clipboard.writeText()` directly. Functions via `execCommand("copy")` fallback in
     the Tauri webview. Deferred to v3.2 scope item 6 for platform layer consistency.

4. **`voiceCommands.ts` unchanged.** Still two commands (`copy`, `clear`). `submit` was originally
   planned for v3.2 but was deferred indefinitely from Voice Scribe (see Deferred from v3).

5. **WebKitGTK recording fallback (triage completion, 2026-04-07).** Push-to-talk recording in the
   Tauri desktop app produced empty audio on WebKitGTK. `getUserMedia` succeeded (mic access was
   fine), but `MediaRecorder` silently produced zero bytes because GStreamer's encoding pipeline
   failed to initialize — a missing API (`automatic-eos` on `GstAppSrc`) prevented the encoder
   from starting. Continuous mode was unaffected because it already captures raw PCM via
   `AudioWorklet` and encodes to WAV in JavaScript, bypassing `MediaRecorder` entirely.

   Three-layer fix:
   - **Backend guard:** `transcribe_ws.py` rejects 0-byte audio with a clear error instead of
     crashing in ffmpeg. New `audio_format` query parameter drives temp file suffix selection;
     ffmpeg still probes magic bytes.
   - **Frontend guard:** `api.ts` catches empty blobs before sending on both WebSocket and HTTP
     paths. Clear error message: "No audio data was captured."
   - **Recording fallback:** `useRecorder.ts` detects when `negotiateMimeType()` returns null (no
     supported `MediaRecorder` format) and falls back to `ScriptProcessorNode` PCM capture →
     `encodeWav()` → WAV blob. Same approach continuous mode uses. The hook's external interface
     is unchanged — downstream code does not know which capture path ran.

   This is not new scope — push-to-talk on the desktop shell was a v3.1 deliverable. The fix is
   resilient to the entire class of GStreamer-version mismatches on Linux, not just this specific
   WSL2 configuration. The `NeedDebuggerBreak` trap and `GstAppSrc automatic-eos` warning (formerly
   in the Runtime Warnings table) were symptoms of the same root cause and are resolved.

**Gate:** Start a second application (e.g., VS Code). Dictate into Voice Scribe (Tauri). Say "copy."
Switch to VS Code. Ctrl+V. Transcript is there. Same test with Ctrl+Shift+Y hotkey. Verify browser
build: `npm run build` produces zero import errors, `npx vitest run` passes, clipboard works in
Chrome.

**v3.2 planning (2026-04-05).** Principal review after v3.1 gate closure: `submit` dropped (WSL2 is
Linux, `SendInput` is Win32 — no path), audio feedback proposed as replacement scope. PM concurred
on deferral, accepted audio feedback as headline, recommended global hotkeys stay as v3.3 (separate
triage surface). Two v3.0 gate sub-items not explicitly verified at the gate session: HTTP fallback
in the Tauri webview and sidecar cleanup on close (`ps aux | grep uvicorn` clean after quit).
Neither blocks v3.2 — engineer runs both at the next `make desktop` session and notes results in
the progress report. `CARGO_MANIFEST_DIR` rework trigger already documented in progress report
(line 258) — no separate tracking entry needed.

#### v3.2 — Audio Feedback + Clipboard Cleanup + Segmentation Fix

**Deliverable:** Audible confirmation when voice commands fire. All clipboard call sites consistent
through the platform layer. Continuous-mode transcript segmentation produces clean segment joins.

**Scope:**

1. **Audio feedback for `copy`.** Short chime plays after `writeClipboard()` resolves successfully.
   Hard requirement: the chime must play after the clipboard write succeeds, not on command
   detection. A chime followed by a silent clipboard failure is worse than no chime at all. If
   `writeClipboard()` rejects, no sound plays. Cue must be low-latency — perceptibly instantaneous
   relative to the action.

2. **Audio feedback for `clear`.** Whoosh/sweep plays immediately when `clear` fires. `clear` is a
   synchronous React state setter — no async timing concern. Cue must be immediately distinguishable
   from the copy chime without visual context.

3. **Audio implementation.** Web Audio API or bundled audio files in `App.tsx` voice command dispatch.
   No backend changes, no new dependencies beyond the sound assets themselves. Both browser and
   desktop contexts should produce the same sounds.

4. **Mute/disable toggle.** Settings panel toggle to silence all audio cues. Users need to disable
   cues without removing the feature. Preference stored locally (same pattern as recording mode
   toggle).

5. **Transcript.tsx clipboard routing (cleanup from v3.1).** The "Copy to Clipboard" button in
   `Transcript.tsx` calls `navigator.clipboard.writeText()` directly instead of routing through
   `platform.writeClipboard()`. It functions via its `execCommand("copy")` fallback in the Tauri
   webview, but is inconsistent with the two call sites migrated in v3.1. Route through the platform
   layer so all three clipboard call sites use the same path.

6. **Transcript segmentation fix.** Continuous-mode segment joins produce no whitespace when below
   the paragraph break threshold. Root cause: `clean_transcript` in `cleanup.py` does `.strip()`,
   so every `result.cleaned` is trimmed on both ends. The separator logic in `App.tsx` line 163–167
   produces `""` when below `PARAGRAPH_BREAK_MS`. Two consecutive segments concatenate with no space
   at the join. Fix the separator and verify:
   - `result.cleaned` whitespace behavior from backend (`cleanup.py` `.strip()`)
   - Partial vs. final transcript merge under concurrent segment completions
   - Paragraph break logic (v2.3.3 fix) still functions correctly
   If investigation reveals deeper issues (ordering bugs under concurrent completions, partial merge
   timing), split into a separate milestone at that point.

**Dependency:** v3.1's `platform.ts` and HTTP clipboard server.

**Not in v3.2:** `submit` voice command. The development environment runs the Tauri desktop app
inside WSL2 (Linux/WebKitGTK). `SendInput` is a Win32 API with no path into the Linux process
namespace. The clipboard delivery loop works end-to-end: dictate → say "copy" → switch app →
Ctrl+V → transcript is there. `submit` is deferred until a Windows-native build happens for other
reasons (distribution packaging, WebView2 migration). The `submitText()` stub in `platform.ts`
remains — it costs nothing and the routing surface is tested.

**Gate:** Dictate → say "copy" → chime plays → switch app → Ctrl+V → transcript is there. Dictate →
say "clear" → sweep plays → textarea is empty. Silence test: force `writeClipboard()` failure (e.g.,
clipboard server not running in desktop mode) → no chime plays. Mute toggle: enable mute → repeat
copy and clear → no sounds play. All three clipboard call sites (`App.tsx` copy command, `App.tsx`
handleCopyTranscript, `Transcript.tsx` button) route through `platform.writeClipboard()`.
Segmentation: three-minute continuous dictation session with varied pause lengths — inspect raw
output for missing spaces between segments, missing line breaks at pause boundaries, double spaces,
unexpected paragraph breaks. Browser build: `npm run build` zero errors, `npx vitest run` passes.

**Gate result (2026-04-08).** Seven gate items pass. All six scope items delivered at `264cc6b`.
Rust-side audio playback added as a completion task after WebKitGTK audio proved unreliable
(devtools kills playback, Bluetooth device switching loses audio path). `rodio` on port 8001,
same `tiny_http` pattern as the clipboard server — `include_bytes!` WAV embedding, fire-and-forget
thread with `Sink::sleep_until_end()`, 204 response. `audio.ts` branches on `isDesktop()`:
browser uses `HTMLAudioElement`, desktop POSTs sound name to Rust. One gate fix: `Transcript.tsx`
copy button was missing the chime — `playCopySound()` added as fire-and-forget after clipboard
write (not `await` — audio failure must not block "Copied!" feedback). WSL2 runtime requires
`libasound2-plugins` + `~/.asoundrc` PulseAudio config for ALSA→WSLg audio bridge. 119 tests
(115 frontend + 4 new desktop audio), TypeScript clean, Rust clean.

#### v3.3 — System Tray + Global Hotkeys

**Deliverable:** Voice Scribe runs in the background. Global hotkey triggers recording from any
application. System tray provides status and quick access.

**Scope:**

1. **System tray.** Tauri v2 `tray` plugin. Icon, menu (Record, Settings, Quit). Status indicator
   (idle, listening, processing).

2. **Global hotkeys.** `@tauri-apps/plugin-global-shortcut`. Replaces the browser `Ctrl+Shift+*`
   bindings when running as desktop app. Browser bindings (`useHotkeys.ts`) remain for web mode.
   Key conflict risk: global hotkeys can collide with other applications. Must fail gracefully with a
   user-visible error if registration fails. The error message and UX for registration failure must
   be implemented (not just handled silently) and verified in the gate. **Configurability is a
   conditional hard requirement:** on Linux, GNOME, KDE, i3/sway, and VS Code all claim keyboard
   shortcut space aggressively — no default binding is reliably conflict-free across common
   environments. If investigation during implementation reveals that no default binding works across
   the target environments, user-configurable bindings become a hard requirement for this milestone,
   not a deferral.

3. **Window management.** Recording triggered via global hotkey while the window is hidden. React
   state updates work regardless of window visibility — needs explicit verification, not assumption.

4. **Full loop verification.** With tray + global hotkeys in place, verify the end-to-end path:
   global hotkey → recording starts → user speaks → transcription → "copy" → clipboard write →
   switch app → paste. Voice Scribe window never appears. This is the scenario the gate must
   exercise. (If `submit` has shipped by this point, also verify direct injection path.)

**Gate:** Hide Voice Scribe to tray. Focus VS Code. Press global hotkey. Dictate. Say "copy."
Transcript is in clipboard. Ctrl+V in VS Code. Voice Scribe window never appeared.
Failure path: with a conflicting hotkey registered in another application, confirm Voice Scribe
surfaces a user-visible error dialog and does not crash. Tray "Quit": confirm sidecar is gone.

**Gate result (2026-04-08).** System tray, window management, event bridge, and state emission
delivered at `20cc2d6`. Global shortcut plugin (`tauri-plugin-global-shortcut`) implemented and
removed: X11's `XGrabKey` registers on WSLg but the handler never fires — WSLg's XWayland does
not deliver grabbed key events. Separately, WebKitGTK intercepts `Ctrl+Shift+Space` (accessibility
activation, alternating dispatch) and `Ctrl+Shift+S` (Save As) at the native level regardless of
the plugin. `Ctrl+Shift+Y` (copy) and `Ctrl+Shift+X` (clear) work reliably in the desktop
webview. Component-level gate items verified on WSLg (tray event routing, state emission, shortcut
failure surfacing, sidecar cleanup on all quit paths, debounce). End-to-end gate scenario (hide →
hotkey → dictate → copy → paste → window never appeared) deferred to native Linux — the event
bridge is wired and tested, re-adding the plugin is a Rust-only change. 169 tests (125 frontend +
44 backend), TypeScript clean, Rust clean.

#### v3.4 — Design System + UI Refresh

**Deliverable:** The frontend has a coherent visual identity, a persistent light/dark theme, and
model selection extracted from the settings panel into the primary toolbar.

**Scope:**

1. **Design system.** Self-hosted fonts — Hanken Grotesk (UI) and Crimson Pro (body text) —
   loaded via `@font-face` from `apps/web/public/fonts/`. All colors expressed as CSS custom
   properties (`--bg-base`, `--bg-surface`, `--accent`, etc.) on `:root`. Zero external font
   requests.

2. **Light/dark theme.** `[data-theme="light"]` block overrides all 10 color tokens plus
   `--recording-glow`. Flash-prevention script in `index.html` reads `localStorage` and falls back
   to `prefers-color-scheme` before React mounts — no unstyled flash on load. Toggle button in
   toolbar; state persisted to `localStorage`. Light palette uses `--accent: #856a28`, which clears
   the 4.5:1 WCAG contrast threshold against both surface values.

3. **Model selector extraction.** `ModelSelector.tsx` extracted from Settings into its own feature
   component (`src/features/model-selector/`). Placed in the toolbar-top alongside the title and
   recorder. Gates fetch on `backendReady` — no spurious API calls before the Tauri sidecar is
   up. Swap status message (duration, error) rendered inline. Settings panel no longer contains
   model-related UI.

4. **Layout refactor.** Three-zone layout: toolbar-top (model selector, title, recorder, theme
   toggle, settings gear), main area (transcript), toolbar-bottom (hotkey hints). Recorder
   compacted to minimal record-btn with animated indicator — no standalone panel.

5. **Comparison panes.** Raw/Edit panes rendered side-by-side when "Show raw / cleaned comparison"
   is enabled. Each pane has its own labeled copy button with source-discriminated "Copied!"
   feedback. Pane is suppressed entirely when `rawText` is absent.

6. **Settings accessible during recording.** Gear button opens settings during an active session
   (recording mode radios stay disabled; "Stop recording to change mode." notice shown). Keyboard
   hotkey (`Ctrl+Shift+S`) and tray `tray-toggle-settings` event retain the recording-state guard
   — stray hotkeys during dictation do not interrupt the session.

7. **Max recording duration.** Number input in Settings → Recording, 5–60 s range, default
   60 s, disabled while a session is active. Push-to-talk auto-stop timer wired in `App.tsx`.
   Value persisted to `localStorage` with clamping. Upper bound matches `MAX_AUDIO_SECONDS`
   in `apps/api/app/config.py`.

8. **Dead code removal.** Model selection UI removed from `Settings.tsx`.

No backend changes. No new API surface. No new Tauri plugins.

**Gate:** Frontend type-check clean. 178 tests pass (134 frontend + 44 backend). Light theme
contrast verified against WCAG 4.5:1 for `--accent`. Flash-prevention script confirmed: reload
with `voice-scribe-theme=light` in localStorage applies light palette before first paint.
Comparison pane copy buttons pass correct content to `writeClipboard`. Desktop hotkey hints show
Y and X only (Space/S not advertised). Settings panel accessible during recording; mode radios
disabled. Max-duration UI capped at 60 s; values above 60 s not reachable via the input.

**Gate result (2026-04-09).** All scope items delivered. Design system, theme toggle, model
selector extraction, layout refactor, comparison panes, settings-during-recording, and max
recording duration UI verified against the implementation. Max-duration input capped at 60 s
(`max={60}` in Settings.tsx, `Math.min(60, ...)` in App.tsx) — matches `MAX_AUDIO_SECONDS` in
`apps/api/app/config.py`. 178 tests (134 frontend + 44 backend), TypeScript clean, Rust clean.

**v3.4 closed the v3 line.** Voice Scribe is feature-complete as a capture primitive *at the
current latency floor*. Further capability expansion (transformation, routing, instrumentation)
still belongs to downstream products that compose with Voice Scribe — see Adjacent Projects.
v4 (below) does not move that boundary: it changes *when* inference happens, not *what* the
product does. Streaming ingestion is capture-layer work — it lowers the latency of transcription
itself, removes temp files from the hot path, and leaves the zero-persistence compliance posture
strictly stronger than before.

---

#### Deferred from v3 (named, not forgotten)

- **`submit` voice command (direct injection)** — types the transcript directly into the focused
  application without clipboard. Requires `SendInput` (Win32). The development environment runs
  inside WSL2 (Linux/WebKitGTK) — no path to Win32 APIs. Direct injection into WSL is too brittle
  and environment-specific to be the next primitive. The near-term direction for downstream products
  is command draft/staging — generating routeable artifacts the user can inspect, edit, and copy —
  rather than direct keystroke injection. Direct execution is deferred pending validation by a
  downstream product that it is the right primitive at all, not just pending a Windows-native build.
  The `submitText()` stub in `platform.ts` and the copy/submit separation architecture remain as
  architectural placeholders. When re-evaluated, Linux/macOS injection (`xdotool`, `CGEvent`)
  remains a separate concern — different APIs, different failure modes.
- **Model management UI enhancements** — download progress, cache management without config files.
  Deferred to v3.x. The settings panel already handles runtime model swap.
- **Auto-update** — Tauri has built-in update support. Not in scope for v3.0–v3.4.
- **Rust-native inference** — single-binary distribution via whisper.cpp. Trigger: "when distribution
  to non-developer users becomes a requirement." Not v3.

---

### v4 — Real-Time Streaming Ingestion (v4.0 implemented and peer-reviewed; v4.1 next — branch `v4-streaming`)

**Deliverable:** Audio streams into inference *while the user is speaking*. The GPU decodes
continuously against a growing in-memory buffer instead of sitting idle until utterance end.
Perceived latency (speech end → final text) drops from ~1.2–1.5 s to a target of ≤ 500 ms, and
partial text becomes visible while the user is still talking.

**Problem statement.** The v2.1 "streaming" is output-only. In continuous mode the full path is:
client VAD waits for a complete utterance → WAV encode → new WebSocket per utterance → server
writes temp file → ffmpeg transcode → full-clip inference → segments stream back. Every stage
starts *after* the user stops speaking. The GPU is idle for the entire duration of speech — the
one window in which inference could have been free.

**Approach — locked decisions (design review checkpoint completed 2026-07-31; full protocol
specification in `docs/v4/protocol.md`, which is the v4.0 acceptance surface):**

- **Model unchanged.** faster-whisper `large-v3` stays. Whisper is an offline 30 s-window model;
  streaming is realized as a *serving policy layer* on top (paced re-decode + prefix commit),
  not a model swap. Natively-streaming architectures (transducer models via sherpa-onnx, Kyutai
  STT) rejected for v4 — abandoning the proven accuracy stack to gain latency is the wrong trade
  for a capture tool, and the policy layer is the transferable serving lesson.
- **Commit policy: LocalAgreement-2** (whisper_streaming / UFAL lineage). Each decode tick
  re-transcribes the uncommitted buffer; the longest common word-prefix between two consecutive
  hypotheses is committed and never re-decoded; the disagreeing tail is surfaced as a tentative
  partial. Agreement-across-time replaces confidence stitching — Whisper token logprobs are not
  calibrated enough to merge overlapping windows in probability space. Confidence enters only as
  a *veto* (see tunables), never as a merge weight.
- **New endpoint `/ws/stream`** — persistent, session-long WebSocket. Supplements, does not
  replace: `/ws/transcribe` (one-shot) and `POST /transcribe` remain the push-to-talk path and
  the fallback, same supplement-not-replace pattern as v2.1.
- **PCM-only ingestion on the streaming path.** Client sends 16 kHz mono `pcm_f32le` frames
  (binary WS messages; format pinned in the `start` handshake, NaN-sanitized on ingest); JSON
  text messages carry control. **Review correction:** `stop` conflated utterance boundary with
  session teardown — the control set is now `start` / `flush` (utterance boundary, many per
  session) / `stop` (session end) / `reset` (destructive drop, acked). No ffmpeg, **no temp
  files** — the buffer lives in memory only (bounded: ≤ ~1.7 MB of audio per session at any
  instant — see protocol §6). Client-side VAD still gates silence at the source (v2.2
  invariant holds). **Review correction:** the client-side per-frame tap does *not* already
  exist — `useVAD.ts` exposes only `onSpeechEnd`; v4.1 wires `onFrameProcessed` (new capture
  plumbing) and must replay the `preSpeechPadMs` pre-roll as the first frames of each
  utterance, or the first word of every utterance reaches the model truncated — see v4.1 scope.
- **Server → client message types:** `ready` (handshake echo: session config + tunables in
  force), `partial` (full replacement of the tentative tail, retractable), `committed`
  (append-only delta, never retracted), `final` (utterance flush: committed text as literal
  prefix + cleaned + metadata), `error` (machine-readable `code` + `fatal` flag), `ack`. All
  server messages carry `seq` + `utterance_id`. Protocol version 1, negotiated at `start`.
- **One active stream session per server.** Single-user tool; no queues, no workers — the
  session loop lives inside the connection handler. A second connection is accepted, told
  `busy`, and closed 4409 (post-accept so the client can read the code). A dead incumbent
  can't brick the slot: idle timeout (10 s) tears it down, and a newcomer preempts an
  incumbent that has been frame-silent ≥ 2 s.
- **Model swap during an active stream is rejected** with HTTP 409 from `/models/swap`, and
  stream start during a swap is rejected with `model_swapping`. Both checks live under a
  **single** module-level guard lock (two flags, one lock — the two-lock version is a TOCTOU
  race). The session pins its model reference at `start`; language is pinned at session start
  and passed explicitly to every decode (per-tick auto-detect flips mid-utterance).

**Serving policy — the tunables (revised at design review; the set changed, see notes below):**

| Parameter | Meaning | Initial value |
|---|---|---|
| `DECODE_TICK_MS` | Interval between re-decode passes over the uncommitted buffer. Main latency/compute dial — commit lag ≈ 2 ticks. | 750 ms |
| `WORD_PROB_FLOOR` | Veto (withhold-only): refuse to commit a word whose `word.probability` is below this, even when two passes agree. Requires `word_timestamps=True` (~+15% per decode, measured). | 0.5 |
| `EDGE_GUARD_S` | Veto (withhold-only): never commit a word whose end timestamp lies within this distance of the buffer end. The structural defense against truncation hallucinations — which agree across ticks with *good* logprobs, because the conditioning that produces them is identical. | 0.6 s |
| `MAX_HOLDBACK_TICKS` | Force-commit ceiling, **frontier-anchored**: the counter keys on the commit-frontier position and resets only when the frontier advances (a global or changed-hypothesis counter either never fires or starves on A-B-A-B alternation). Bounds worst-case latency. | 6 |
| `MAX_UNCOMMITTED_S` | Uncommitted-buffer cap (renamed from `MAX_BUFFER_S = 28`, which was a review-caught arithmetic bug: 28 s + left context exceeds Whisper's 30 s window, and `pad_or_trim` **silently truncates** — the tail words would simply vanish). Window invariant, enforced by the planner: `LEFT_CONTEXT_S (3.0) + MAX_UNCOMMITTED_S (24.0) + SAFETY_S (3.0) ≤ 30.0`. | 24 s |

Review notes on the set: the originally proposed `COMMIT_LOGPROB_FLOOR = −1.0` and
`NO_SPEECH_MAX = 0.6` were **removed** — those values duplicate faster-whisper's internal
defaults (`log_prob_threshold`, `no_speech_threshold`), which already skip and
temperature-fallback on them inside the library, so the veto would have been near-dead code
reporting "0 fires" while providing no protection; and a segment-mean `avg_logprob` cannot
protect a word-level commit decision anyway (two hallucinated edge words hide inside a healthy
20-word average). Word-level probability + the edge guard replace them. Agreement is compared
on a normalized key (NFKC → casefold → strip edge punctuation), commits the raw surface form
from the *newer* hypothesis, and a word must be non-terminal in both hypotheses to be eligible
(terminal words carry unstable punctuation/casing — without this guard, holdback force-commit
becomes the steady-state commit path on ordinary speech). Decode settings on this path:
`word_timestamps=True`, `vad_filter=False` (server-side re-segmentation destabilizes agreement;
the client gates at the source), `condition_on_previous_text=False`. All hypothesis comparison
happens in absolute sample coordinates; left-context audio is suppressed from hypotheses by
timestamp, never by string matching. Non-space-delimited languages (ja, zh): flush-only in v4 —
whitespace tokenization would treat the utterance as one word; revisit with the tutor project.

Plus two non-tunable rules: **VAD flush** — when the client signals speech end (`flush`),
cancel any in-flight tick, decode the remaining uncommitted buffer once, finalize. Silence is
ground truth; no agreement needed. This is what bounds finalization latency in practice. And
**backpressure** (promoted from the deck's vocabulary slide to a locked decision): one decode
in flight per session, ticks never queue; next tick at `max(now, tick_start + DECODE_TICK_MS)`
with overruns counted in `ticks_skipped`; three consecutive overruns double the effective tick
interval (cap 4×). Idle ticks are skipped below `MIN_DECODE_S = 1.0` s of uncommitted audio
(near-silence decodes are Whisper's most reliable hallucination trigger); the first tick of an
utterance fires as soon as 1.0 s is buffered, which is what keeps first-partial ≤ 1.5 s.

**Latency targets (the gate is a measurement, not an opinion):**

- First partial visible ≤ 1.5 s. **Anchor pinned at v4.1 (field-test-review addition (3),
  rationale in `docs/v4/protocol.md` amendments):** the gate number is measured from
  `first_frame_sent` on the client wire clock — the clock the v4.2 dials actually move; as
  of v4.1 the gate line is the per-utterance **p50** (single-sample per session before).
  The user-perceived number ("from speech onset") is separate and additive: wire number
  plus VAD detection lag (spike-measured) minus the pre-roll head start (the ~0.9 s
  pre-roll burst front-loads `MIN_DECODE_S`, so it *reduces* the wire number — the v4.2
  `STREAM_MIN_DECODE_S` projection predates this term). Reports carry
  `first_partial_anchor`.
- Final transcript ≤ 500 ms from speech end. **Measurement origin, pinned at review:** the
  v4.0 number is measured from server receipt of `flush` (what `stream_bench` controls);
  `stream_bench` also reports it from true speech end in the source WAV. The client-side VAD
  detection lag (`redemptionMs = 1400` in vad-web's defaults — the current "~1.2–1.5 s"
  baseline is anchored to that *late* event) is a separate, additive v4.1 number. Without
  pinning this, bench says 400 ms, live feels like ~1.9 s, and the gap gets blamed on
  "browser overhead". Reducing `redemptionMs` (1400 → 600–800) is a v4.2 tuning lever:
  with streaming, the tail is already decoded before the redemption window expires.
  **Instrument line re-specified at v4.1 (measurement-based refinement, per the
  ticks_skipped precedent):** at ≥ 20 utterances the gate is
  `finalization_max_excl_first ≤ 0.5 s` — a max-based tail guard that excludes exactly one
  sample, the utterance-1 warm-up flush carry, which is a named v4.2 item (2.1–3.8 s in the
  u3 field sessions while every subsequent flush ran 0.22–0.35 s). p50 and the raw max are
  reported alongside; a p50-only line was rejected at the plan review (blind to the tail —
  five 3 s finals would pass it at 20 utterances).
- Committed text retraction rate: **zero by construction** — verified by replaying the message
  log through a reference reducer (a retraction = any message whose effect is that the client
  displays different committed text for a given `(utterance_id, offset)` than before)
- **Force-commit rate < 5% of committed words, and committed-vs-one-shot WER < 3%** (added at
  review: force-commit preserves zero-retraction while committing unagreed text — without
  these two numbers the retraction gate passes at 100% force-commit, i.e. on a broken policy)
  **Reference re-specified at v4.1 (field-test-review addition (1); the 2026-08-01 record
  invalidated the chunked reference):** the comparison runs against a **per-utterance
  ≤ 60 s unchunked one-shot reference** — each streamed utterance's own audio posted whole
  to `/transcribe` (identical samples on both paths; > 60 s segments are WER-excluded,
  never chunked). Analyzed only at ≥ 200 pooled reference words; reports carry
  `wer_reference`/`baseline_kind` so runs are attributable. Divergences are bucketed by
  distance to the nearest commit boundary (exposure-normalized), force-commit rate is
  reported per-utterance, and forced spans get their own line: `forced_span_wer < 10%`,
  gated only at ≥ 20 forced words, with an evaluated/skipped counter.
  **Failure protocol (decided before the first run) — and its outcome, executed on that
  first run (2026-08-01, 20-utterance silence-split gate run):** a `wer_micro < 3%` miss is
  diagnosed via the buckets; boundary-concentrated divergence is a commit-policy defect and
  blocks, boundary-independent divergence is a measurement-based re-spec recorded here.
  Measured: `wer_micro` 11.7% with a **flat** boundary profile — 13.2% within 0.25 s of a
  commit boundary vs 10.1% beyond 1 s (1.3×, inside binomial noise at these counts),
  `forced_span_wer` 0.0, force-commit rate 2.9%. The guarded failure modes are absent; the
  aggregate number is the independent decode-regime divergence the field test already
  triangulated on this same recording (both sides ~15% vs the 423-word script, streaming
  the more stable side — the < 3% aggregate was a word-for-word-equivalence claim this
  measurement falsifies rather than a quality-parity claim). **Re-specified lines,
  matching the review's own intent ("forced spans are precisely where the WER check must
  look"):** gate = `divergence_not_boundary_concentrated` (near-boundary rate ≤ 2× far-field
  rate, evaluated at ≥ 20 divergences) **and** `forced_span_wer < 10%`; `wer_micro` is
  reported, never gated. Word-for-word equivalence between decode regimes is not a v4
  claim; committed-text quality claims route through the script-triangulated WER and the
  forced-span line.
- Per-tick health: `tick_occupancy = decode_ms / DECODE_TICK_MS`, p95 ≤ 0.7, and
  `ticks_skipped == 0` on the gate run (review correction: the original "RTF < 1 per tick"
  ratio — decode time ÷ *audio duration* — scores 0.05 during exactly the runaway it exists
  to catch; measured per-tick cost is ~230–260 ms on the target GPU regardless of buffer
  length, since the encoder always pads to 30 s, so occupancy against the tick budget is the
  ratio that detects trouble)
- `dropped_audio_ms == 0` on the gate run (overrun drops are signaled, never silent)
- GPU re-decode overhead: measured and reported (expected 3–5× the audio's real-time compute;
  at 750 ms ticks the projection is ~4–5× — already the top of the envelope, which is one of
  the two reasons the tick stays at 750 ms; see resolved question 1)

**Hardware cost justification (v3 → v4).** The streaming path deliberately spends compute to buy
latency. That trade must be quantified, not asserted: `stream_bench` runs the *same* audio through
the v3 one-shot path (baseline) and the v4 streaming path, and reports both sides — decode-seconds
per audio-second, GPU utilization duty cycle (sampled via `nvidia-smi` during the run), peak VRAM,
and per-tick decode time (the RTF-per-tick number that must stay < 1 or the buffer grows without
bound). The gate result publishes the comparison as a cost/benefit table: X× compute premium
bought Y ms of perceived latency. If the premium lands outside the expected 3–5× envelope, that
is a tuning finding (tick too fast, buffer trim not working), not a number to quietly accept.

**Sub-milestones:**

- **v4.0 — Backend session loop + measurement harness.** `/ws/stream` per `docs/v4/protocol.md`
  (the acceptance surface — session tests name the clauses they enforce), in-memory buffer,
  paced decode loop (asyncio task + `to_thread`, cancel-event drain — not a bare thread),
  LocalAgreement commit as **pure functions in absolute sample coordinates** (`plan_window`,
  `localize`, `agree`, `trim_plan` — the seam widened at review so the trim/slide arithmetic
  is testable without threads), VAD-flush finalization. Contract artifact obligations ship in
  the same milestone: stream message models in `CONTRACT_MODELS` + a guard test that every
  `Ws*` schema class is registered (the drift test alone cannot catch an unregistered model),
  contract doc + schema regenerated, `privacy-data-flow.mmd` updated for the new backend path
  (moved here from v4.1 at review — the diagram maps where audio can exist in the process,
  and downstream consumers reach this endpoint without the frontend). Driven by a synthetic
  PCM test client (`ops/scripts/stream_bench.py`) that replays a WAV at real-time pace and
  reports first-partial latency, finalization latency (both anchors), commit lag distribution,
  retraction count (via reference reducer), force-commit rate, committed-vs-one-shot WER,
  tick occupancy, per-tick decode time vs token count — plus a baseline mode that runs the
  same audio through the v3 one-shot path and emits the hardware cost comparison. The harness
  ships *with* the endpoint — tuning without instrumentation is guessing. No frontend changes
  in v4.0. (A v4.1 de-risk spike — verify `onFrameProcessed` in the pinned vad-web delivers
  contiguous, undecimated 16 kHz frames — was scoped to run during v4.0 but **was not run**;
  flagged at the peer review and promoted to the first task of v4.1, below.)
- **v4.1 — Frontend integration.** **First task, before any capture plumbing: the
  `onFrameProcessed` de-risk spike** (promoted from v4.0, where it did not run) — verify the
  pinned vad-web delivers contiguous, undecimated 16 kHz frames; if it decimates or drops,
  the capture source changes and the rest of v4.1 re-plans around that finding.
  **Spike result (2026-08-01): PASS — capture source confirmed.** vad-web pinned exact
  0.0.30; harness `apps/web/spike/vad-frames.html` (dev-only, not in the prod build;
  synthetic chirp + tone bursts injected via `getStream`, metrics-only artifacts). Chromium
  151 headless, AudioWorklet adapter, matrix {legacy/1536, v5/512} × {48 kHz, 44.1 kHz}:
  sample-count ratio error −0.11 to −0.15 % (bound ±1 %), zero non-finite samples, min
  windowed correlation 0.943–0.967 vs the analytic 16 kHz reference, tone-burst spacing
  exact, resampler drift ≤ 29 samples (~1.8 ms over an 8 s chirp — the box resampler's
  missing fractional carry, measured and negligible), roll-off −2.7 dB @ 7.1 kHz
  (report-only; matches the box-filter analytic estimate, acceptable for speech). Static
  findings recorded with the harness: `onFrameProcessed` fires on every frame while active
  (speech and silence), `onVADMisfire` fires for < 400 ms segments (client must `reset`),
  vad-web's internal pre-roll ring is not surfaced per-frame (hence the client ring), and
  `startOnLoad` invokes `getStream` at construction. WebKitGTK and real-mic runs carry to
  the v4.1 live smoke (in-library `processorType: "ScriptProcessor"` is the contingency).
  Then: persistent WS session in continuous mode, frames streamed
  via `onFrameProcessed` (**new capture plumbing** — review correction: no per-frame tap
  exists today, `useVAD.ts` exposes only `onSpeechEnd`), client-side pre-roll ring replaying
  `preSpeechPadMs` (~800 ms) as the first frames of each utterance (vad-web's pad exists
  *because* Silero clips onsets; without the replay, the first word of every utterance — the
  word LocalAgreement commits earliest and never retracts — reaches the model truncated, and
  the quality-parity gate line fails for reasons unrelated to the commit policy),
  partial-vs-committed rendering (tentative gray tail after committed text), degrade ladder
  per protocol §10 with the client retaining each utterance's PCM until its `final`.
  `state-machine.mmd` updated **before** component code (new states: streaming session live,
  partial visible). Per-utterance WebSocket churn eliminated.
  **Field-test-review additions (2026-08-01, all three reviewers concur v4.1 starts now):**
  (1) **The < 3% WER line, re-specified as a named v4.1 deliverable** — per-utterance ≤ 60 s
  *unchunked* one-shot reference (a > 60 s chunked baseline is invalid as a reference: cuts
  land mid-phrase by construction and chunk decodes hit temperature fallback), with
  stream-vs-oneshot divergence bucketed by distance to the nearest commit boundary so
  "independent mishearings" is measured rather than asserted. `stream_bench`'s hard-coded
  0.03 gate threshold updates together with the reference. The line's intent survives the
  re-spec because the failure mode it guards — force-commit laundering unagreed text into
  committed output — measured 0 in every u3 field session; the u4 re-run then showed the
  rate is boundary-dependent (5.1% at mid-speech cuts — see the force-commit finding in the
  field-test record), which strengthens this deliverable: forced spans are precisely where
  the WER check must look. (2) **Idle-timeout /
  keepalive protocol decision, before capture plumbing:** C1.5 tears down a session after
  10 s without frames, C2.6 forbids sending silence, C3.7 makes unknown control types fatal,
  and C10.2 makes the resulting drop to one-shot permanent for the session — so a user who
  pauses twelve seconds to think loses streaming until restart. No replay harness can
  surface this. Options: additive `ping` control message (C3.7 amendment), longer idle
  timeout with slot-hygiene rationale restated, or fresh-session re-establishment on
  `session_timeout`. Decide deliberately, record the rationale in `docs/v4/protocol.md`.
  (3) **First-partial anchor decision:** pin whether the number is measured from server
  receipt or user-perceived speech onset (VAD detection lag and pre-roll replay sit in front
  of the server clock) before anyone tunes against the wrong clock. (4) **Harness
  completion:** per-utterance first-partial/finalization p50/max (today first-partial is a
  single sample per session) and one gate run at a VAD-representative utterance count
  (≥ 20 over the same recording) — the 3–4-utterance runs stay too, as the only exerciser of
  the > 24 s slide.
- **v4.2 — Voice command fast path + tuning pass.** `detectVoiceCommand` runs on committed text
  as it lands instead of waiting for utterance completion — **`copy` only** (resolved question
  2 below: `clear` never fast-paths). Tunables adjusted against `stream_bench` numbers and
  real dictation; `redemptionMs` reduction evaluated here, gated on false-finalization rate.
  **Carried inputs from the field test (2026-08-01; measured numbers in the field-test
  record):** the re-specified tick-skip line (ratio ≤ 1% with `tick_multiplier == 1`, see
  record), the first-partial floor (`STREAM_MIN_DECODE_S` 1.0 → 0.8 is the named change,
  projected ~1.4 s first partial; the pass must measure hallucination rate at 0.8 s), the
  utterance-1 flush-finalization carry, and the compute premium — **above the 3–5× envelope,
  which triggers resolved question 1's beam-1 lever** (premium > 5×); that lever's WER check
  depends on the v4.1 re-specified reference landing first. The 500 ms tick is empirically
  closed: all three of its stated preconditions failed at the field test (p95 occupancy
  0.57–0.59 > 0.50, ticks skipped 2 > 0, premium well above 3.3×) — do not re-litigate.

**Scope guardrails (named at review so creep is visible when it knocks):**
- `stream_bench` stays in `ops/scripts/`, manually invoked, never imported by runtime code,
  never wired to the frontend, and measures from the *client* side of the protocol — the
  server gains no instrumentation hooks. Opt-in instrumentation is Voice Workspace's scope.
- v4.2 changes *when* the existing detector runs, not *what* it detects. No new commands, no
  arguments/targets in v4. Any vocabulary change re-runs Gate 1 per the v2.3.1 process.
- Per-segment logprobs/probabilities stay internal to the veto. Exposing confidence or
  structured output on the wire is the Integration Contract decision, driven by a downstream
  need — not by the data sitting one field away.
- No per-commit command dispatch hook and no undo/restore buffer in v4.0 or v4.1. v4.1
  exposes committed text to the app layer for rendering and stops there; v4.2 owns dispatch.
  (An undo buffer is a new retained-content surface in the milestone whose compliance story
  is "persistence gets stronger" — killed with resolved question 2.)

**Testing (folded into each sub-milestone, not a trailing phase):**

- **Commit policy as a pure function.** The LocalAgreement core (`agree(prev_hyp, curr_hyp) →
  (committed, tentative)`, logprob veto, holdback counter, buffer-trim arithmetic) is implemented
  as pure functions with no model, no WebSocket, no threads — and unit-tested exhaustively on
  synthetic hypothesis sequences: agreement, partial agreement, flip-flop until holdback fires,
  veto blocking an agreed prefix, trim offsets after commit, left-context carryover at the 30 s
  slide. This module is where correctness lives; it must be testable without a GPU.
- **Session tests (pytest).** `/ws/stream` exercised with the same model-mocking pattern the
  existing 46 backend tests use, each test naming the protocol clause it enforces:
  control-message sequencing (`start` → `ready` → frames → `flush`/`stop`), second-session
  rejection (post-accept 4409), preemption and idle timeout, mid-session disconnect cleanup
  (asserted deterministically: session task done, guard flag cleared in `finally`, buffer
  weakref dead after gc, next session connects — *not* `threading.active_count()`, which is
  flaky against a thread pool), swap-during-stream 409 both directions under the single guard
  lock, frame validation (empty/oversized/non-multiple-of-4/NaN), out-of-order control. No
  CUDA required, same as today.
- **Frontend tests (vitest, v4.1).** Partial-vs-committed rendering, retraction of the tentative
  tail, fallback to the one-shot path when `/ws/stream` fails, session teardown on unmount
  (`wsCleanupSetRef` discipline extends to the persistent session).
- **`stream_bench` doubles as the regression harness.** Latency numbers recorded in the gate
  result the same way smoke-test latency was recorded in v1 — a tunables change that regresses
  the numbers is visible, not vibes.

**Design review checkpoint — completed 2026-07-31, before any v4.0 code.** Fresh-context
adversarial reviews by all three personas (Principal: protocol contract; Senior Engineer:
commit policy + implementation risk, with live decode-cost measurements on the target GPU;
PM: scope, limits, compliance). Verdict: commit-policy approach and sub-milestone structure
approved; the protocol as sketched was **not** approved — "three bullet points where it needs
to be a specification." Outcome: `docs/v4/protocol.md` (protocol v1) pins everything the
reviews required — `flush`/`stop` split, `ready` handshake, `pcm_f32le` + frame validity,
error-code enum with `fatal`, `seq`/`utterance_id`, the `final`-has-committed-as-prefix
invariant, streaming limits table, single guard lock for session/swap, preemption + idle
timeout, and the privacy retention model. The standing questions all resolved into protocol
clauses: swap-during-stream (§8), disconnect cleanup (§1), buffer-slide correctness (§7 —
including the caught 28 + 3 > 30 truncation bug), buffer-edge hallucination (edge guard,
§7.4), and `partial` retraction honesty (full-replacement semantics + the commit-or-withhold
formulation, §5). The proposed segment-level vetoes were replaced (near-dead code at their
stated values — they duplicated faster-whisper's internal defaults). Two review blockers were
also structural: the branch was missing the v3.4.1 contract artifact (merged from main before
any v4 work), and the 60 s/10 MB hard limits silently didn't apply to a session-long stream
(replaced by the protocol §6 limits table).

**Open questions — resolved at the design review (2026-07-31):**

1. **Initial tick value: 750 ms, confirmed by measurement — not a compromise.** Per-tick decode
   cost on the target GPU is ~230–260 ms *regardless of buffer length* (the encoder always
   pads to 30 s; cost scales with token count, ~12 ms/token at beam 5). At 750 ms the healthy
   tick occupancy is 0.35–0.60 with headroom for slow ticks; at 500 ms it is 0.52–0.90 with no
   margin for exactly the stalled-frontier case that matters, and — because the dominant cost
   is fixed encoder work — the compute premium scales with 1/tick: 500 ms multiplies it by
   1.5×, from a projected ~4–5× (top of the committed envelope) to ~7× (outside it). Moving to
   500 ms requires all three, on a three-minute real-dictation `stream_bench` run at 750 ms:
   p95 tick occupancy ≤ 0.50, `ticks_skipped == 0`, and measured premium ≤ 3.3×. First lever
   if the premium exceeds 5×: `beam_size=1` for tick decodes (~30% cheaper, measured), flush
   stays at beam 5 — adopted only after `stream_bench` reports committed-vs-one-shot WER at
   beam 1.
2. **`clear` never fast-paths — resolved as option (b), unanimous across reviewers.** The fast
   path applies to `copy` only; `clear` is confirmed only on `final` (the utterance boundary
   *is* the confirmation, exactly as today). Three independent reasons: (i) LocalAgreement
   commits word prefixes mid-utterance by construction, so "clear" lands as a standalone
   committed token in the middle of "clear the cache" as *routine* behavior — the streaming
   path manufactures the v2.3.1 false-positive vector; (ii) the zero-false-fire gate on an
   unbounded input surface is unfalsifiable — it can be failed but never passed, so in
   practice it converts to "ship and watch," which is what the severity asymmetry exists to
   prevent; (iii) two-pass agreement is structurally vulnerable to identical truncation
   hallucinations at the buffer edge (same conditioning both ticks, good logprobs) — the
   exact condition under which a fast-path `clear` would fire. Re-open trigger: `copy` shows
   zero false fires over a defined field sample *and* a recoverable undo is separately scoped
   and reviewed on its own compliance merits. Not v4.
3. **Review timing — rationale confirmed; the fallback was not needed** (the full review ran
   before v4.0). Two amendments, recorded for the next time a review must be cut: the
   buffer-slide/retention model belongs on the *protocol* side of the split (it is the
   in-memory retention story the contract's privacy section publishes, plus a
   message-semantics question — whether `final` can contradict `committed`), not on the
   deferrable commit-policy side; agreement/veto/holdback *tuning* is what defers to the
   v4.0→v4.1 boundary. This question is resolved, not standing — it does not get re-litigated
   at v4.1.

**Gate (v4.0 — self-contained, no frontend running):**
- Protocol conformance: session tests green, each naming its `docs/v4/protocol.md` clause;
  second-session 4409, preemption, idle timeout, swap 409 both directions, disconnect cleanup
  (deterministic assertions), frame validation, out-of-order control.
- Pure core: the policy module imports and tests with no model, no WebSocket, no threads —
  agreement, partial agreement, flip-flop until frontier-anchored holdback fires, word-prob
  veto, edge guard, terminal-word guard, trim offsets after commit (including a word
  straddling the boundary), left-context suppression by timestamp, window invariant.
- `stream_bench` on GPU with `large-v3`: first partial ≤ 1.5 s; finalization ≤ 500 ms from
  server receipt of `flush` (both anchors reported); retractions = 0 via reference reducer;
  `final.raw` committed-prefix invariant asserted per utterance; force-commit rate < 5%;
  committed-vs-one-shot WER < 3%; p95 tick occupancy ≤ 0.7; `ticks_skipped == 0`;
  `dropped_audio_ms == 0`; buffer slide exercised by a run longer than `MAX_UNCOMMITTED_S`
  with retractions still 0 and no unbounded memory growth.
- Cost table in the gate result: decode-seconds per audio-second both paths, GPU duty cycle
  (`nvidia-smi` sampled), peak VRAM, per-tick decode time vs token count — stated as "X×
  bought Y ms," deviation from the 3–5× envelope explained, not accepted.
- Zero-persistence verified, not read off the code: `TEMP_DIR` watched during a bench run (no
  files); no log line carries transcript/hypothesis/audio content; no committed bench artifact
  contains transcript text; VRAM and process table clean after session close.
- Contract: stream schemas in `CONTRACT_MODELS` + guard test; contract doc updated (transport
  table corrected, per-path limits, close codes, error enum, privacy retention model, 409 on
  swap, `final.duration` provenance); schema regenerated; drift test green.
  `privacy-data-flow.mmd` updated and re-rendered. Test counts recounted, not estimated.
- All existing tests green; one-shot and HTTP paths unchanged (no assertion edits).

**v4.0 status (recorded 2026-07-31, RTX 3090 / large-v3 / float16, bare-host server):**
implemented and measured — endpoint, pure core, guard, session tests (23) + policy tests (32),
contract artifact updated, `stream_bench` operational against the live GPU backend.
- **Correctness targets: met on every run.** Retractions 0 (reference reducer), `final.raw`
  committed-prefix invariant holds, `dropped_audio_ms` 0, force-commit rate 0.
- **Latency targets: partially met — tuning-pass material with named causes.** Finalization
  from `flush`: 0.32–0.53 s across runs (target ≤ 0.5; spikes when the flush waits on an
  in-flight tick — bounded by per-tick decode time, lever: beam-1 ticks). First partial:
  1.6–1.8 s (target ≤ 1.5; decomposition: 1.0 s `MIN_DECODE_S` + first-tick decode 650–1000 ms,
  vs ~300–520 ms warm ticks — a load-time warmup decode recovered ~350 ms of one-time kernel
  cost; the residual first-tick premium and the `MIN_DECODE_S` value are the v4.2 dials).
- Warm tick occupancy ~0.4–0.6 at 750 ms; the backpressure ladder (skip → 2× → 4×) was
  observed firing correctly under an adversarial fixture (repeated identical audio triggers
  Whisper temperature-fallback loops, 2–5 s decodes — a fixture artifact, and a useful stress
  test). Long-form quality comparison (WER < 3%) needs varied real dictation — the repeated
  fixture collapses on the one-shot path, making WER meaningless; it lands with the
  three-minute live session at the v4-overall gate.

**v4.0 post-implementation peer review (completed 2026-07-31, three fresh-context personas —
same pattern as the design review):** Principal and PM: sign off with conditions; Senior
Engineer: reject — confirmed correctness defects, all fixed and regression-tested the same
day (session tests 23 → 33, policy tests 32 → 34, backend total 102 → 114). The confirmed
findings, for the record:
1. **Post-flush coordinate misalignment (blocker):** `plan_window` reaches left-context
   seconds below the buffer trimmed at flush; decode and localize now share a clamped window
   start. Before the fix, every utterance after the first emitted empty partials or
   misaligned/duplicated commits — invisible to both the test suite and the harness, because
   both flushed exactly once per session. `stream_bench` gained `--utterances N`; gate runs
   use ≥ 3.
2. **Overrun regime (blocker):** the buffer was never trimmed on overrun (§6's 1.7 MB bound
   was unenforced — up to 7.7 MB resident) and `dropped_audio_ms` re-added the whole overflow
   every tick. Now: trim at the slid window start, watermarked accounting (each dropped
   sample counted exactly once), and the flush window is planner-bounded — audio reported
   dropped is never decoded.
3. **Edge guard anchor:** the guard was measured against the live buffer end, which frames
   arriving mid-decode inflate — effective guard ≈ 0.6 s − decode time. Now anchored to the
   decoded-audio snapshot.
4. **Frontier jitter (20 ms tolerance):** re-decodes re-time words by up to one Whisper
   frame; a committed word drifting later by < 20 ms committed twice — append-only, so
   invisible to the retraction reducer. Suppression now tolerates one frame.
5. **Tick pacing:** the loop slept *after* the decode, so the real cadence was
   `tick + decode_ms` (~1.0–1.3 s at a 750 ms tick), and `ticks_skipped` counted overlong
   decodes rather than missed grid slots. Fixed to C7.8 (`max(now, tick_start + tick)`).
   **This invalidates the latency/occupancy numbers recorded above — they were measured on
   the slower cadence and must be re-measured at the field test before any v4.2 tuning.**
6. **C7.11 was unimplemented:** ja/zh/th sessions now run flush-only (partials only, commits
   at flush) instead of force-committing whole utterances through whitespace tokenization.
7. Smaller confirmed items: swap-vs-swap race in the guard, `PolicyConfig.validate()` never
   called in production (env overrides could reintroduce the 30 s truncation), preemption
   timeout proceeded with two sessions on the GPU (now rejects the newcomer), a
   decode-or-flush-in-flight incumbent could be preempted as "stale" (now reports zero frame
   age), per-tick logging demoted to debug, wire messages now round-trip-validated against
   the exported schemas in tests. Protocol amendments (wire behavior unchanged) and the
   clause reconciliations deferred to v4.1 are recorded at the end of `docs/v4/protocol.md`.

**Gate lines not closed by the 2026-07-31 run — deferred to the field test, not silently:**
the cost table (decode premium vs the 3–5× envelope; the instrument exists in
`stream_bench --baseline`, the numbers were not recorded in the gate result), the empirical
zero-persistence sweep (`TEMP_DIR` watch during a run, log sweep, post-session VRAM/process
check), `ticks_skipped == 0` on a nominal varied-audio run (the recorded runs exercised the
adversarial fixture, and the counter's semantics changed with the pacing fix), p95 tick
occupancy reported *as a p95* (the recorded value was a warm-tick range), and the > 24 s
buffer-slide run (now also covered by an automated overrun test; the live-GPU slide
observation still lands with the field test). Runbook: `docs/v4/field-test.md`.

**v4.0 field test (2026-08-01, RTX 3090 / large-v3 / float16, bare-host server, WSL2; runbook
`docs/v4/field-test.md`):** 222 s of varied live dictation against a 423-word rehearsed script,
`--utterances 3` (≈ 74 s segments — every session exercises the post-flush path three times and
slides the buffer far past 24 s). Five full sessions: three at `--utterances 3` (two gate runs
plus one WER diagnostic), then — after the same-day three-persona review of this record — two
at `--utterances 4` (boundaries 55.5/111/166.5 s) with new telemetry: the C7.9 flush
drain/decode split the review found had never been built, per-tick overrun warnings,
`occupancy_max`, and `decode_seconds_total`. Counters-only reports committed:
`docs/v4/field-test-report-2026-08-01-u3.json` / `-u4.json`. One harness defect found and
fixed first: `--baseline` sent the whole recording to the one-shot path, whose 60 s cap 400'd
and the crash discarded the streaming stats — baseline now chunks at the cap
(`oneshot_chunks`), a baseline failure fails the gate via `baseline_completed` (never a
silent exit 0), and the chunk PCM conversion clips instead of wrapping.

- **Correctness: pass in every session.** Retractions 0 (reference reducer), committed-prefix
  invariant holds, `dropped_audio_ms` 0, non-empty partials in every utterance of every
  session (force-commit: see its own finding below). The long utterances slid the buffer well
  past the 24 s span with commits keeping the uncommitted window small (~2 s) — no overrun
  trims, coordinates stable (**> 24 s buffer slide: deferred line, closed**). The post-flush
  blocker is confirmed dead on real audio.
- **Latency (first valid numbers on the corrected cadence — supersedes the invalidated
  2026-07-31 figures).** First partial 1.32–1.63 s across five sessions, straddling the
  ≤ 1.5 s target. Floor decomposition (corrected at review — the first version of this record
  understated it): 1.0 s `MIN_DECODE_S` + first decode 0.3–0.6 s + up to ~0.15 s poll/frame
  quantization; the target is reachable only when the first decode is warm-fast.
  `STREAM_MIN_DECODE_S` is the v4.2 dial. Finalization from flush, now measured with the C7.9
  drain/decode split: drain 0–110 ms and flush decode 211–241 ms on all eight u4 flushes →
  0.22–0.35 s client-observed on every utterance, so the ≤ 0.5 s line **passes on the u4
  sessions**; the u3 sessions did **not** close it (the instrumented line is the max across
  flushes, and utterance 1 ran 2.1–3.8 s). The outlier is boundary-content-dependent: u4's
  boundaries avoid the hard region near ~72–74 s and the outlier vanishes entirely. (Review
  correction: this record originally corroborated the fallback explanation with the one-shot
  chunk-1 stall — wrong region; chunk 1 covers 0–55.5 s, not the flush window. The u4
  experiment is the actual evidence.) Commit lag p50 1.69–1.71 s, max 2.98–3.88 s.
- **Per-tick health (deferred lines, closed — line re-specified).** `occupancy_p95`
  0.552–0.585 (target ≤ 0.7: pass) over 289–292 ticks per session; `occupancy_max` 0.86–0.87
  on the u4 sessions, now logged alongside it (p95 is blind to the overrun tail by
  construction — the max is what sees a breach). `ticks_skipped`: 2 per u3 session, **0 in
  both u4 sessions**. Review correction: the u3 skips were originally attributed to the flush
  decodes, which cannot increment the counter — they were tick decodes whose windows piled
  uncommitted tail against the hard ~74 s boundary; with u4 boundaries the same audio
  produces zero overruns. Deterministic per boundary configuration, not a pacing defect;
  `tick_multiplier` never left 1 in any session. The `== 0` line is re-specified — a
  measurement-based refinement, recorded as such, since an absolute zero is content-dependent
  on real speech: **`ticks_skipped / ticks ≤ 1%` and `tick_multiplier == 1` at session
  close** (2-in-291 with instant recovery is the designed skip-and-continue behavior).
  *(v4.1 correction: this record originally claimed "the harness gate and this line now
  agree" — wrong; the tick-health lines are server-internal, read from the session-close log
  entry, and `stream_bench` has never carried them. The server gains no instrumentation
  hooks (scope guardrail), so the runbook's gate procedure names the log line as the source
  of these two numbers.)*
- **Cost table (deferred line, closed — with a finding).** Stated in the gate's own metric
  (review correction: the first version of this record used whole-GPU duty-cycle ratios,
  noisy on a WSL2 desktop — decode-seconds is now logged directly as `decode_seconds_total`
  at session close). Streaming: 97.9–98.6 decode-seconds over 222.1 audio-seconds = **0.44
  decode-s per audio-s**. One-shot: 13.0–21.3 s wall for the same audio = 0.058–0.096 (the
  spread is temperature fallback on the chunked baseline). **Premium 4.6–7.6×, central
  ≈ 5.9×** — above the 3–5× envelope centrally, which per the rule above is a tuning finding,
  not a number to accept: every 750 ms tick re-encodes a 30 s-padded window, so tick
  interval, beam-1 ticks (triggered at > 5× per resolved question 1), and `MIN_DECODE_S` are
  the v4.2 levers. For reference: GPU duty cycle 0.63–0.64 streaming vs 0.98–1.0 one-shot,
  peak whole-GPU VRAM 5.3–6.4 GiB. Note the measured premium is a lower bound for the v4.1
  workload: 3–4 flushes per 222 s is far below VAD-gated dictation's 20–40, and each flush
  is a full-window beam-5 decode — the VAD-representative run (v4.1 harness completion) is
  the number v4.2 tunes against.
- **WER (deferred line, measured — reference re-specified).** `committed_vs_oneshot` on the
  full recording: 19.1% (u3) / 15.3% (u4) — but a > 60 s one-shot reference is not clean: the
  cap forces a chunked baseline, arbitrary cuts land mid-phrase, and a chunk hit temperature
  fallback in 3 of 5 runs. Triangulated against the 423-word rehearsed script with S/D/I
  counts (review required counts, not just ratios): stream 15.1% (u3) and 14.9% (u4, S/D/I
  34/5/24) — stable across runs; chunked one-shot 15.6% (u3) but **19.9%** (u4, S/D/I
  23/10/51 — 51 insertions, 41 words over the script length: fallback hallucination). The
  streaming path is the *more stable* side of the comparison, which is the strongest form of
  the invalid-reference conclusion. Stream-vs-oneshot divergence: 14.6% (u3, only 8% of
  errors numeric) / 18.3% (u4, S/D/I 15/46/24, dominated by one-shot insertions). 29–41% of
  each side's script errors are numeric formatting (the script spells out numbers, Whisper
  emits digits); the remainder splits between speaker deviation from the script and per-side
  errors. **Quality parity holds as an aggregate claim**; word-for-word equivalence is not
  established, and is exactly what the re-specified per-utterance ≤ 60 s unchunked reference
  with commit-boundary bucketing (v4.1 scope) will measure.
- **Force-commit (new finding, u4 re-run).** `force_commit_rate` was 0 in all three u3
  sessions but **5.1% (22 of 432 words) on the u4 bench session** — the even-split
  boundaries cut mid-speech where the u3 splits happened to land clean, and the holdback
  valve fired as designed. Harness-boundary artifact in origin (real flushes follow VAD
  silence), but it demotes "force-commit 0" from a session invariant to a
  boundary-dependent observation: v4.1's VAD-aligned runs must report the rate
  per-utterance, and any run with force-commit > 0 needs the re-specified WER check on
  exactly the forced spans.
- **Zero-persistence sweep (deferred line, closed — all four conjuncts, completing the
  partial closure the review flagged).** `TEMP_DIR` observed empty during an active
  streaming session and after session close (the stream path creates no files); log sweep
  clean — zero hits for distinctive transcript vocabulary across the full server log
  (operational telemetry only); post-session with the backend still live: VRAM back at the
  idle-with-model level (~4.1 GiB service share — no per-session leak) and no stray decode
  processes; after backend shutdown VRAM returns to the 1.0 GiB system baseline. The report
  JSONs contain counters only.
- **Footprint (feeds the README sizing table):** service VRAM ≈ 4.0 GiB idle with large-v3
  loaded, ≈ 5.3 GiB peak while streaming (whole-GPU reading minus the 1.0 GiB desktop
  baseline).

**v4.1 build + gate record (2026-08-01, RTX 3090 / large-v3 / float16, bare-host server,
WSL2; three-persona plan consult before implementation — PM/Principal/Senior blockers folded
into the plan):** executed in the review-locked order. (1) `onFrameProcessed` spike: PASS,
recorded in the v4.1 bullet. (2) Protocol: ping keepalive (C3.8) with the `idle_timeout_s`
capability signal on `ready` (version-skew-safe), C2.4/C2.5/C4.6 reconciliations resolved
(C2.5 by code — fixed burst credit), C10.2 default rule, C10.3 bounded FIFO, close codes
closed as coarse, first-partial anchor pinned, 1500 s client session rotation for C1.6.
Backend tests 114 → 118, contract regenerated. (3) Diagrams before code, including the
`privacy-data-flow` client retained-audio surfaces. (4) Capture plumbing: useVAD per-frame
tap (9-frame pre-roll ring, redemption-tail gating — at most 192 ms of trailing silence
reaches the flush decode), `streamSession.ts`, live region, App integration with
outstanding-flush FIFO accounting (forced/stop/ceiling finals handled), silent degrade with
FIFO replay, ModelSelector session guard, tray state. Frontend tests 134 → 190, tsc + cargo
clean. (5) Harness re-spec + **two recorded gate runs**
(`docs/v4/field-test-report-2026-08-01-v41-{u20-silence,u3}.json`, counters only):
- **u20 silence-split (VAD-representative — the numbers v4.2 tunes against):** every line
  PASS except `finalization_max_excl_first` — 0.573 s vs ≤ 0.5 (1 flush of 20; p50 0.322,
  the C7.9 drain ≈ one-full-decode structural tail surfacing at 20 samples where 4 never
  showed it — **miss with named cause, carried to v4.2**, beam-1 tick/flush decodes is the
  lever). First partial p50 1.212 s (max 2.28 — quiet segment onsets, reported);
  commit lag p50 1.62 s; force-commit 3.7 % (< 5 %), `forced_span_wer` 0.0 over 14 forced
  words (below the 20-word gate floor — reported); retractions 0, alignment ok,
  dropped 0. Server close line: `ticks_skipped` 1/281 = 0.36 % (≤ 1 %),
  `tick_multiplier` 1, `occupancy_p95` 0.57. **Cost (new regime,
  `baseline_kind=per_utterance_unchunked` — not comparable to the retired chunked figure):**
  92.1 decode-s / 222.1 audio-s = 0.415 streaming vs 0.064 one-shot → **premium ≈ 6.5×** —
  still above the 3–5 × envelope; resolved question 1's beam-1 lever remains triggered for
  v4.2. `wer_micro` 12.4 % reported (near-boundary 15.5 % vs far-field 9.9 % — see the WER
  re-spec record in the gate list; three same-audio runs measured 11.2–12.4 % aggregate,
  stable, boundary profile flat-to-1.6×, inside far-bucket noise).
- **u3 even (slide exerciser, > 24 s buffer slide):** **all lines PASS** — the utterance-1
  warm-up carry (2.11 s) is excluded by exactly the gate's one-sample exclusion and is the
  v4.2 item; `max_excl_first` 0.36 s. Server: `ticks_skipped` 3/288 = 1.04 % — the known
  adversarial-boundary configuration (mid-phrase ~74 s cuts); the VAD-representative run is
  the binding tick-health number.
- **Boundary-concentration diagnostic re-specified to report-only on its second run** (the
  2.0× ratio gate flipped on identical audio because the far-field bucket carries 3–7
  divergences per run, and the near bucket structurally contains the single-pass flush-tail
  regime): recorded in `stream_bench` and the gate list; gate candidate at v4.2 with a
  second recording.

**Automated live browser smoke (2026-08-01, headless Edge 151 vs the real App + live GPU
backend, driver `apps/web/spike/smoke.html`):** validated end-to-end from the real UI —
Record click opens one streaming session; ping keepalive held a zero-frame session alive
for ~2 minutes and the slot released cleanly on close (C1.5/C3.8 observed live, twice); a
VAD-triggered utterance streamed frames → flush → `final` → textarea; live region rendered
a tentative tail and cleared at final; Stop drained to done; no error states. **Content
check not closed:** Edge headless's `--use-file-for-fake-audio-capture` feeds fake-device
noise (~0.002 RMS) instead of the WAV regardless of input level (measured via the spike's
mic-RMS probes) — the one detected "utterance" was a near-silence hallucination, which is
itself a live confirmation of why 4a's redemption-tail gating exists. Realistic-speech
content validation therefore lands with the interactive smoke.

**Interactive real-mic smoke (2026-08-01, started — partial):** live dictation against the
real App + live GPU backend, real microphone. Findings: (a) **adjacent-word boundary
doubling at high visible rate** — ~5 instances in one short dictated passage ("change
change", "was was", "is is", "our our", "observe observe"); always a single immediately
adjacent duplicate at a flush boundary — the flush-boundary re-emission signature.
Pause-heavy live dictation makes it far more visible than the harness runs (every pause =
VAD flush = boundary); this promotes a **boundary dedup guard** (text +
timestamp-epsilon match at flush start) to a named v4.2 priority. Log-prob token
stitching alone does not fix it — both duplicate occurrences are confident; it is a
coordinate problem, not a confidence problem. **Refinement from continued live use
(2026-08-02):** the doubling lands at phrase *ends*, and at least one observed pair
("very Very") differs in capitalization — the second copy is sentence-initial.
**Mechanism diagnosed at the 2026-08-02 three-persona review (initial pre-roll-overlap
hypothesis REFUTED by all three reviewers):** the pre-roll ring cannot overlap the
previous utterance — frames enter the ring only while not speaking, `resetTapState()`
empties it at `onSpeechEnd`, and ~12 undelivered redemption frames (~1152 ms) separate
consecutive utterances' wire audio; overlap is structurally 0 ms. The actual mechanism
is **server-side, intra-`final`, at the flush seam**: the flush decode window opens
exactly at the commit frontier with no left context (`stream_ws.py` `do_flush`), its
`localize` call passes the same value as both window start and boundary (suppression
structurally a no-op), and `agree()` never runs on the flush path — while the frontier
itself is a DTW word-end estimate that routinely lands tens of ms early. The residue of
the last committed word opens the flush window and, with
`condition_on_previous_text=False`, is re-emitted sentence-initial at position 0 —
"very Very" exactly, one duplicate per VAD pause. Predicted by the C7.2 amendment
record; invisible to the recorded gate runs because they exercise one flush per session.
Fix (v4.1, review-mandated): flush left context (`FLUSH_LEFT_CONTEXT_S`, capped ~1.0 s
to protect the finalization line) + a seam-suppressor pure function in `stream_policy`
(leading word only, `normalize_token` equality, start within `SEAM_TOLERANCE_S` of the
frontier, ≤ 1 word/flush, suppressions counted on the session-close line). Client-side
dedup rejected (C5.1 — it would be a user-visible retraction invisible to the wire
reducer). Related root cause for suspected finding (c): the flush path has no
probability floor at all (the word-prob floor lives only in `agree()`), and a `useVAD`
threshold-coupling leak (frames at prob ∈ [0.25, 0.30) release the full held queue —
vad-web neither advances nor resets its redemption counter in that band) can push
~1.3 s of near-silence into the flush decode, so the documented "at most 192 ms of
trailing silence" guarantee does not hold as written — both fixed under v4.1; the
flush-tail `avg_logprob`/`no_speech_prob` veto stays a v4.2 candidate only if (c)
survives these fixes. (b) Near-homophone substitution ("Pawn"
for "upon") — one-shot same-audio comparison not yet run. (c) **Suspected
filler→"upon" insertion at pause points** (recurred across messages at odd positions) —
if confirmed by transcript-vs-spoken comparison, this is the hallucination-veto case:
extend the existing word-prob floor with an `avg_logprob`/`no_speech_prob` flush-tail
veto. (d) GPU ~50 % util — expected; matches the `occupancy_p95` 0.57 paced-decode
design. **Committed-text stability held: no committed-text mutation observed (explicitly
checked); tentative-tail flicker at utterance head/tail is as designed.**

**Field-bug fix record (2026-08-02, review-mandated; commits `3666c4f` + docs):**
executed in the review-locked order — classify, rate, fix, re-measure.
- **HR-1 classification (stream_bench seam counters, new):** synthetic 8-utterance seam
  probe (repo `test.mp3` ×3 per utterance, 800 ms gaps — the original gate recording is
  deleted by privacy design) against the pre-fix server: **3 of 8 flushes intra-`final`
  seam duplicates, 0 inter-`final`** — mechanism confirmed at the wire, cross-utterance
  path refuted by measurement as well as geometry. Pre-fix rate recorded → fix falsifiable.
- **Fix (a) structural:** flush window opens `STREAM_FLUSH_LEFT_CONTEXT_S` (1.0 s,
  validate-capped ≤ `left_context_s`) before the frontier, localized against the frontier
  — tick-shaped; `MIN_FLUSH_DECODE_S` now gates on the uncommitted tail, not the window.
- **Fix (a) guard:** `suppress_seam_duplicate()` pure function (C7.12 four-way
  conjunction: leading word, `normalize_token` equality, `STREAM_SEAM_TOLERANCE_S` 0.10 s,
  ≤ 1/flush); applied in `do_flush` before `policy_flush()` (un-deads `flush()`);
  suppressions counted (`seam_suppressions`, session-close line). Client-side dedup
  rejected per C5.1.
- **Fix (VAD band leak):** `useVAD` held-frame release gates on the positive threshold
  (0.30) where vad-web's redemption counter actually resets; thresholds/pads passed
  explicitly to `MicVAD.new`, tap constants derived; held queue bounded
  (`HELD_MAX_FRAMES` = 2× redemption, oldest streamed on overflow). The "≤ 192 ms trailing
  silence" claim now holds as written (cap-bounded under sustained borderline noise).
- **Diagnostics for (c) attribution (numbers only, C9.2):** flush log line carries
  `tail_s`, worst-segment `avg_logprob`/`no_speech_prob`, `seam_suppressed`. The v4.2
  flush-tail veto is built only if (c) survives these fixes (OR-form or tighter — the
  faster-whisper AND-form at defaults is a structural no-op; whole-tail withhold, never
  word edits).
- **Post-fix same-audio re-run:** **seam duplicates 3 → 0**, and `seam_suppressions` = 0 —
  the structural fix alone cleared them; the guard fired never (backstop only, zero
  observed false positives). Retractions 0, prefix invariant ok, force-commit 0.125 →
  0.122, finalization p50 0.319 → 0.276 s / max 0.651 → 0.676 s (probe noise, no material
  regression from the +1.0 s window). HR-8's delta-vs-2026-08-01 on the original gate
  recording is impossible (audio deleted); the u20-equivalent gate re-run lands with the
  fresh recording from the live-smoke sitting.
- **Docs:** protocol C5.2 corrected ("never re-decoded" → never re-*committed*), C7.12
  added with the accepted-residual-risk statement, 2026-08-02 amendments block. Tests
  324 (194 fe / 130 be), tsc clean, contract unchanged (no wire change).

**Still open before v4.1 sign-off (human-in-the-loop):** completing the interactive smoke —
full ~3-min continuous dictation (committed text never mutates; post-fix duplicate rate
observed live), kill-server-mid-stream → one-shot fallback with PCM replay, `ps`/VRAM
clean after session close, transcript-vs-spoken comparison for findings (b)/(c) (counts
and rates only — no transcript text or audio in the repo); a fresh-recording u20
silence-split gate run (HR-8 deltas vs 2026-08-01 stated); `make desktop` for the
WebKitGTK adapter check (ScriptProcessor is the in-library contingency); VAD detection
lag measurement (spike page: speech-file run or mic); and the three-persona review of
the amended record (mechanism review completed 2026-08-02; sign-off review pending the
smoke).

**Gate (v4 overall, at v4.1/v4.2):** everything above still holding, plus:
Three-minute live continuous dictation session: committed text never visibly changes; partial
tail flickers but never survives incorrectly into committed text; streaming-vs-one-shot quality
on the same audio judged by the **re-specified WER lines** (wer_micro reported +
`divergence_not_boundary_concentrated` + `forced_span_wer` — see the latency-targets section;
word-for-word equivalence was retired as a v4 claim, and this bullet previously restated the
retired form — reconciled 2026-08-02 per PM review) (with the pre-roll replay in place —
without it this line fails for capture reasons, not policy reasons). Kill the server mid-stream → frontend
falls back to the one-shot path gracefully, replaying the retained utterance PCM. `ps`/VRAM
clean after session close. Client VAD detection lag reported as its own number next to the
server-side finalization latency.

---

## Adjacent Projects (Separate Silos)

These compose with Voice Scribe but are **not part of its roadmap**. They are separate projects with separate repositories. This boundary is stated explicitly to prevent scope erosion.

**Text-to-Speech (TTS)** — the output half of the voice conversation loop. Voice Scribe handles input (speech → text); TTS handles output (text → speech). Together they enable a hands-free conversational interface. Same local-first constraint — no cloud APIs. Models to evaluate when the time comes: Coqui TTS, Bark, VITS, Piper.

**Language Tutor Agent** — a conversational agent for foreign language pronunciation and speaking practice. Primary target: Japanese. Listens to the user speak (via Voice Scribe STT), compares against expected pronunciation, provides corrective feedback, converses in the target language. Integrates with existing Anki flashcard resources. Dependencies: Voice Scribe, TTS project, and a language-aware evaluation model.

**Voice Workspace** (working title) — a multi-pane voice workspace that layers cleanup, structuring, audience routing, and artifact rendering on top of raw speech capture. Voice Scribe provides the capture layer (Speech Capture in the pipeline below). This product owns everything beyond raw capture:

Pipeline architecture: Speech Capture (Voice Scribe) → Transcript Cleanup / Normalization → Intent & Audience Routing → Artifact Rendering → Execution / Export / Handoff.

Owned scope:
- Second-stage local cleanup model (candidates: Gemma 4 E4B, Qwen 4B-class, Phi-4-mini) powering all non-raw panes
- Multi-pane UI: Raw (from Voice Scribe), Clean, Structured, Directed/Actionable
- Transformation modes: Clean (punctuation, sentence boundaries, minor repairs), Structured (summary, action items, open questions, decisions), Directed (rewritten for a chosen audience), optional future Compressed (token-efficient downstream representation)
- Audience/role routing: PM, Principal Engineer, Senior Engineer, General — with explicit routing commands (`refine principal`, `scope principal`, `handoff senior`, `summarize PM`) and structured audience metadata
- Intent decomposition: routing layer extracting target audience, action type, artifact type, subject, constraints
- Opt-in performance instrumentation and benchmarking
- Recording control redesign (demote stop button, workspace as visual center of gravity)
- Copy-vs-route action model reconsideration (observed usage suggests Clear > Copy frequency; clipboard may be secondary to route/send/transform actions)
- Command draft/staging as the near-term delivery primitive (routeable artifacts the user inspects/edits/copies, not direct keystroke injection)

Separate repo. Separate compliance posture — introducing metadata collection (even opt-in, even local-only) requires its own security and privacy review independent of Voice Scribe's zero-persistence contract.

Product principles (govern this product, not Voice Scribe):
- Raw transcript remains editable and first-class
- Refinement is opt-in, not forced
- UI privileges workspace over controls
- Routing and transformation should be fast and obvious
- Performance instrumentation is opt-in only, default off
- Content privacy preserved by default
- Second-stage model powers all derived panes except raw
- Schema-agnostic public contract — no private upstream schema leakage

**Integration contract — delivered.** `docs/contract/runtime-contract.md` is the stable, versioned description of what Voice Scribe exposes to downstream consumers. The machine-readable companion `docs/contract/runtime-contract.schema.json` is generated from the Pydantic models in `apps/api/app/schemas.py` and kept in sync by `apps/api/tests/test_contract_export.py` — the test fails if schemas.py changes without a corresponding schema regeneration. Contract version equals the Voice Scribe git tag of the release that ships the file. Breaking changes bump the major component. Richer fields (segment timestamps, confidence scores, structured boundaries) are additive changes driven by a concrete workspace need; they appear in a future contract version, not this one.

---

## Deferred Decisions

These are deferred by design, not by oversight: OpenAPI-generated frontend contracts, domain/infra folder split, queue/background workers, reverse proxy.

---

## Development Environment

**Repo location:** WSL Linux filesystem (e.g., `/home/<user>/projects/voice-scribe`).

**Tools:** VS Code with WSL extension, Docker Desktop with WSL 2 backend, Chrome for frontend testing.

**Supported browser for v1:** Chrome on Windows.

---

## Public Release Checklist (Pre-Release)

**Must include before public release:**
- README
- SECURITY.md
- Privacy docs
- Threat model docs
- Release checklist
- Dependency and secret scanning in CI
- Contract export test green; `docs/contract/runtime-contract.schema.json` regenerates without diff

**Must not publish with:**
- Permissive network exposure
- Transcript or audio logging enabled by default
- Committed secrets
- Real user data
- Unprotected debug endpoints

---

## Engineering Rules

**Repository:** No secrets, real audio, real transcripts, or runtime artifacts committed. `.env.example` only.

**Runtime:** Audio discarded by default. Transcription bounded by timeouts. Request size and duration capped. Temp cleanup required. Health endpoint reports actual device mode.

**Product:** Transcript is always editable. User controls final text. Text output matters more than automation. Architecture stays flat until complexity is earned.

---

## Summary

Ship small. Earn the right to make it bigger. Build the primitive, then build on top of it. Voice Scribe is the capture layer. Products that transform, route, or render voice output compose with it — they don't extend it.

---

## Ideas (Parking Lot)

Not planned. Not scoped. These surfaced naturally while building and are worth remembering when the time is right. Items promoted into the roadmap are marked as such.

**Docker image size reduction**
The `nvidia/cuda:12.6` base accounts for ~2.1GB of the image on its own. Several CUDA packages — `libnccl`, `libnpp` — are not used by faster-whisper for single-GPU inference. Auditing and trimming could meaningfully reduce image size.

**MIME magic-byte validation**
Adding magic-byte checking to `validate_mime_type` would be a one-line addition. Natural pre-condition before any networking work — not needed for a localhost single-user tool.

**Security hardening as a pre-condition for network exposure**
Before anything leaves localhost, the threat model should be revisited. MIME hardening, rate limiting, and bind address controls are the obvious starting points.

~~**Model selection UI**~~ — promoted to v2.0.

~~**Voice activity detection (VAD)**~~ — promoted to v2.1.

~~**Streaming partials**~~ — promoted to v2.1.

**Speaker diarization — single-voice isolation gate**
In multi-speaker environments (office, meeting, language tutoring session), the VAD fires on any voice. The target use case is turn-based conversation with clear pauses between speakers — not overlapping voices. The missing piece is a speaker gate: enroll the target voice, then reject audio chunks that don't match before they reach `encodeWav` and the WebSocket pipeline. If the gate stays client-side (ONNX/WASM, same pattern as the existing VAD), no backend changes are required — the API continues to receive clean single-speaker blobs. The one bounded addition to the current model is voice embedding storage: a serialized Float32Array in `localStorage` is sufficient, no server persistence required. The agent TTS sub-case (AI response playing through device speakers) is already handled by `echoCancellation: true` on the `MediaStream` — no new work needed there. **Design review required before scoping:** enrollment UX, embedding model selection (ECAPA-TDNN and similar have ONNX exports suitable for browser), and gate threshold calibration. Getting the threshold wrong means the user's own voice is filtered under noisy conditions — worse than the current behavior.

**Voice command prefix redesign — post-v2.3 finding**
Manual testing revealed two reliability problems with the "scribe" prefix: (1) Whisper conflates "scribe" with "subscribe" under rushed or adverse speech conditions, producing false negatives; (2) VAD cuts the two-word phrase at the natural pause between prefix and action verb, splitting "scribe stop" into "Scribe." + "Stop." — neither matches. The "scribe" prefix was chosen for phonetic distinctiveness in developer dictation, but two syllables ending in a fricative before a vowel-initial verb creates an inherent pause point. The pipeline is correct; the vocabulary needs redesign. Candidate approaches: (a) a single strong-consonant wake syllable ("hey", "yo", short and hard to mishear); (b) fused two-syllable command words with no internal pause point (e.g. "stopscribe", "pushit"); (c) configurable prefix so users can pick what works for their voice. Design review required before any prefix change — the detection logic is a one-line table update, but Gate 1 must re-run for any new vocabulary.

**Client-side keyword detection for voice command latency**
Voice commands pay the full transcription round-trip (~1.2–1.5s from speech end to action). The latency is architectural — `detectVoiceCommand` runs after backend inference returns. Candidate approach: lightweight client-side model (small vocabulary, ONNX/WASM, same hosting pattern as Silero VAD) that detects command words locally and fires immediately, bypassing the backend. Regular dictation continues through the full pipeline. Becomes more pressing in v3.2 when `submit` injects text into a focused application. Design review required before scoping.

**CPU-only deployment path**
The CPU sidecar path is verified end-to-end. `make desktop-cpu` exercises it via target-specific Make variables (`DEVICE=cpu WHISPER_MODEL=small WHISPER_AVAILABLE_MODELS=small`), with env propagation confirmed Makefile → shell → cargo → Tauri → sidecar → `config.py`. Measured latency: ~1.87s on `small` with i9-12900K. The mechanical gap is closed. Open question: is CPU-only a distribution target (machines without NVIDIA GPUs) or a development convenience? That framing determines whether it warrants documentation as a supported deployment path or remains a developer-facing fallback only.

---

## Thoughts

**Makefile target restructure — dev vs prod separation**

The current `make dev` and `make dev-cpu` targets spin up a Docker container for the API, which adds lifecycle overhead (build, up, down) to every dev cycle. `make desktop` avoids this entirely — Tauri spawns the Python sidecar directly, and Ctrl+C cleanly stops everything. The dev targets should follow the same pattern.

Proposed split:
- **`make dev`** / **`make dev-cpu`** — run both services directly on the host (frontend + bare Python API), no Docker. Ctrl+C stops everything. Same developer experience as `make desktop` but in the browser.
- **`make desktop`** — Tauri webview + sidecar. Already works this way.
- **`make prod`** — the Docker path. Containerized, built images, production-like deployment. This is where Docker belongs: packaging and distribution, not the inner dev loop.

The goal: Docker stops being a dev dependency and becomes a packaging concern. Dev = fast iteration, prod = deployment.