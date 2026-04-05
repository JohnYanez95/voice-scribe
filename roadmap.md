# Voice Scribe — Roadmap

**Last Updated:** April 4, 2026
**Status:** v2.3.3 Complete — v3 scoped

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

---

## Design Principles

**Local-first.** Audio and transcripts stay on the user's machine. No cloud services required.

**Host for interaction, container for inference.** The browser owns mic access, clipboard, and editing. The container owns model loading and inference.

**Audio is transient, text is durable.** Raw audio is short-lived input. Transcripts are the user-facing artifact.

**Scope matches the milestone.** Repo structure and services reflect current reality, not future aspirations.

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

**A second GPU-backed model for cleanup** is deferred — evaluated and found unnecessary for this use case. Revisit only if Whisper output quality degrades on longer recordings or non-English dictation.

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

- **Tauri v2** — locked. Plugins: `@tauri-apps/plugin-clipboard-manager`,
  `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-shell` (sidecar), tray via
  `tauri::tray`. Rust side uses Tauri v2 API (`tauri::Builder`, `tauri::AppHandle`). v1 plugins are
  not forward-compatible; this is not revisitable.

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

- **Voice command surface** — three commands: `copy` (clipboard write, native API removes focus
  requirement), `clear` (buffer wipe, carried from v2), `submit` (direct injection into focused
  application, Tauri-only). `copy` and `submit` are separate commands with separate risk profiles —
  clipboard write is safe and predictable; injection requires focus to be correct and must be opted
  into deliberately. Collapsing them removes the user's safe fallback. `submit` is registered in
  `COMMAND_MAP` unconditionally; execution is platform-conditional. In browser context, `submit`
  executes the same path as `copy` (clipboard write — the safe fallback). Specific words subject to
  gate evaluation; the command separation is non-negotiable.

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
- **Bare-host startup validation** — pending. Gate: `cd apps/api && source .venv/bin/activate &&
  uvicorn app.main:app --host 127.0.0.1 --port 8000` starts, `/health` returns `"device": "gpu"`,
  model loads from `~/.cache/voice-scribe`.
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
   - Remaining: `CORS_ORIGINS` must include the Tauri webview origin (determined during scaffolding —
     `tauri://localhost` or `https://tauri.localhost` depending on Tauri v2 config). On Windows/WSL2,
     Tauri v2 defaults to `https://tauri.localhost`; Linux uses `tauri://localhost`.

4. **WebSocket origin enforcement.** `transcribe_ws.py` line 40 and `main.py` line 44 both read from
   `settings.cors_origins`. A single `CORS_ORIGINS` config update covers both surfaces. The gate must
   explicitly verify WebSocket streaming from the Tauri webview — not just HTTP health checks. Without
   this, the gate can pass on the HTTP fallback path while the primary transport is silently rejected
   with a 4003 close.

5. **Makefile update.** `make desktop` target starts the sidecar + Tauri dev mode. Existing
   `make dev` (Docker + Vite) stays untouched.

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
   - `writeClipboard(text: string): Promise<void>` — Tauri: dynamic
     `import("@tauri-apps/plugin-clipboard-manager")` → `writeText()`; browser:
     `navigator.clipboard.writeText()`
   - `submitText(text: string): Promise<void>` — stub in v3.1, calls `writeClipboard()` in both
     environments. Filled in v3.2 for Tauri.

   Dynamic `import()` is the mechanism. Vite does not resolve dynamic imports at static analysis time.
   `vite.config.ts` adds `optimizeDeps.exclude` for `@tauri-apps/` packages. If dynamic import fails
   despite exclusion, fallback is a Vite `resolve.alias` mapping `@tauri-apps/*` to no-op stubs in
   browser builds — documented as contingency, not plan.

2. **Tauri clipboard plugin.** `@tauri-apps/plugin-clipboard-manager` declared in Tauri `capabilities`
   config. Tested on Windows.

3. **Clipboard call site routing.** Two call sites in App.tsx route through `platform.writeClipboard()`:
   - `case "copy"` voice command: `navigator.clipboard.writeText(transcriptRef.current)`
     → `platform.writeClipboard(transcriptRef.current)`
   - `handleCopyTranscript`: `navigator.clipboard.writeText(transcript)`
     → `platform.writeClipboard(transcript)`
   - Both keep the existing `.catch(() => {})` fire-and-forget contract.

4. **`voiceCommands.ts` unchanged.** Still two commands (`copy`, `clear`). The `submit` entry lands
   in v3.2.

**Gate:** Start a second application (e.g., VS Code). Dictate into Voice Scribe (Tauri). Say "copy."
Switch to VS Code. Ctrl+V. Transcript is there. Same test with Ctrl+Shift+Y hotkey. Verify browser
build: `npm run build` produces zero import errors, `npx vitest run` passes, clipboard works in
Chrome.

#### v3.2 — `submit` Voice Command (Direct Injection, Windows-Only)

**Deliverable:** Saying "submit" types the transcript directly into the focused application. No
clipboard involved. Windows-only for this milestone.

**Scope:**

1. **OS-level keystroke simulation.** Rust side uses `SendInput` via the Windows API (crate: `enigo`
   or equivalent). Exposed as a Tauri command. Receives transcript text from the webview via IPC,
   simulates keyboard input into the focused window.

2. **Focus management.** The injection target is whatever was focused before Voice Scribe. With
   system tray (v3.3), focus is already elsewhere. Without tray, the user must have tabbed away.
   Hard requirement: restore focus to the previous window before injecting. Focus management on
   Windows has edge cases across window managers and accessibility settings. A one-week soak period
   of daily use is required before marking v3.2 complete — included as a gate condition.

3. **Voice command registration.** `voiceCommands.ts`: `VoiceCommandKey` becomes
   `"copy" | "clear" | "submit"`, `COMMAND_MAP` gains `"submit": "submit"`. Detection layer stays
   platform-unaware. App.tsx gains `case "submit"` → `platform.submitText(transcriptRef.current)`.

4. **Platform layer fill-in.** `platform.ts` `submitText()`:
   - Browser: calls `writeClipboard()` (safe fallback, identical to `copy`)
   - Tauri: calls Tauri IPC command → Rust `SendInput` injection

5. **False-positive testing.** Severity asymmetry: accidental `submit` types arbitrary text into
   whatever application has focus — worse than accidental `copy`. Gate must include false-positive
   testing with sentences containing "submit" as a non-command word.

**Dependency:** v3.1's `platform.ts` must be in place. The platform layer is the routing surface for
all platform-conditional behavior — it's not just a clipboard concern.

**Deferred:** Linux/macOS injection. Named deferral — different APIs (`xdotool`, `CGEvent`), different
failure modes. Windows-only is pragmatic scope discipline.

**Gate:** Dictate into Voice Scribe. Focus VS Code editor. Say "submit." Transcript appears at cursor
in VS Code. No clipboard involvement. False-positive test: 10 sentences containing "submit" as a
non-command word, zero fires. Soak period: one week of daily use before marking complete.

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
   be implemented (not just handled silently) and verified in the gate. Configurability deferred.

3. **Window management.** Recording triggered via global hotkey while the window is hidden. React
   state updates work regardless of window visibility — needs explicit verification, not assumption.

4. **Full loop verification.** With tray + global hotkeys + `submit` in place, verify the end-to-end
   path: global hotkey → recording starts → user speaks → transcription → "submit" → text appears in
   focused app. Voice Scribe window never appears. This is the scenario the gate must exercise.

**Gate:** Hide Voice Scribe to tray. Focus VS Code. Press global hotkey. Dictate. Say "copy" (or
"submit"). Transcript is in clipboard (or typed into VS Code). Voice Scribe window never appeared.
Failure path: with a conflicting hotkey registered in another application, confirm Voice Scribe
surfaces a user-visible error dialog and does not crash. Tray "Quit": confirm sidecar is gone.

#### Deferred from v3 (named, not forgotten)

- **Model management UI enhancements** — download progress, cache management without config files.
  Deferred to v3.x. The settings panel already handles runtime model swap.
- **Linux/macOS `submit` injection** — different OS APIs, different failure modes. Deferred to v3.x.
- **Auto-update** — Tauri has built-in update support. Not in scope for v3.0–v3.3.
- **Rust-native inference** — single-binary distribution via whisper.cpp. Trigger: "when distribution
  to non-developer users becomes a requirement." Not v3.

---

## Adjacent Projects (Separate Silos)

These compose with Voice Scribe but are **not part of its roadmap**. They are separate projects with separate repositories. This boundary is stated explicitly to prevent scope erosion.

**Text-to-Speech (TTS)** — the output half of the voice conversation loop. Voice Scribe handles input (speech → text); TTS handles output (text → speech). Together they enable a hands-free conversational interface. Same local-first constraint — no cloud APIs. Models to evaluate when the time comes: Coqui TTS, Bark, VITS, Piper.

**Language Tutor Agent** — a conversational agent for foreign language pronunciation and speaking practice. Primary target: Japanese. Listens to the user speak (via Voice Scribe STT), compares against expected pronunciation, provides corrective feedback, converses in the target language. Integrates with existing Anki flashcard resources. Dependencies: Voice Scribe, TTS project, and a language-aware evaluation model.

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

Before public release, the repo must include: README, SECURITY.md, privacy docs, threat model docs, release checklist, dependency and secret scanning in CI.

Do not publish with: permissive network exposure, transcript or audio logging enabled by default, committed secrets, real user data, unprotected debug endpoints.

---

## Engineering Rules

**Repository:** No secrets, real audio, real transcripts, or runtime artifacts committed. `.env.example` only.

**Runtime:** Audio discarded by default. Transcription bounded by timeouts. Request size and duration capped. Temp cleanup required. Health endpoint reports actual device mode.

**Product:** Transcript is always editable. User controls final text. Text output matters more than automation. Architecture stays flat until complexity is earned.

---

## Summary

Ship small. Earn the right to make it bigger. Build the primitive, then build on top of it.

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

**Single `docker compose up` for full stack**
Adding the frontend as a second service in `compose.dev.yml` so one command starts everything. Small change, meaningful quality of life.

**CPU-only deployment path**
The CPU fallback is wired and verified (v1 close-out, ~1.87s latency on i9-12900K with `small` model). Worth exploring whether CPU inference could run outside Docker entirely, accelerating the v3 Tauri packaging work.