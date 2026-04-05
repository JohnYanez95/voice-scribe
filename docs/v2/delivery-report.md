# Voice Scribe v2 — Delivery Report

**Date:** April 4, 2026
**Author:** Johnraymond Yanez
**Status:** v2.3.3 Complete — v3 Next

---

## Executive Summary

Voice Scribe v2 has been delivered across three sequenced sub-milestones. Each built on the prior one and was gated behind it.

**v2.0** added keyboard-driven control and runtime model management: a hotkey system for recording, copy, clear, and settings; a slide-out settings panel with live model selection; and a full-stack model swap endpoint with threading safety and VRAM cleanup.

**v2.1** changed the transport layer: WebSocket streaming is now the default, with faster-whisper segments streamed to the frontend as they complete. The original HTTP POST endpoint remains as an automatic connection-level fallback. A raw/cleaned comparison toggle was added to support ongoing transcript quality evaluation.

**v2.2** added continuous recording mode: the mic stays open, browser-side VAD (Silero v4 via ONNX/WASM) detects speech onset and offset, each detected utterance is encoded to WAV and dispatched through the existing WebSocket endpoint, and transcripts accumulate across utterances with silence-based paragraph breaks. No backend changes were required.

The v1 architecture — two services, plain HTTP over localhost, temp file cleanup in `finally`, no logging of content — held without modification throughout. v2 extended the interaction model; it did not change the security posture or the operational constraints.

---

## Architecture at v2.2

```
[Browser UI — localhost:5173]
    Push-to-talk:  MediaRecorder (webm/opus) → Stop → WS binary → segments → transcript
    Continuous:    VAD (AudioWorklet, ONNX) → onSpeechEnd → encodeWav → WS binary → accumulate

           │  WebSocket ws://localhost:8000/ws/transcribe  (default)
           │  HTTP POST  http://localhost:8000/transcribe   (fallback, push-to-talk only)
           ▼

[API Container — localhost:8000]
    Origin check → receive_bytes() → size check → temp file
        → asyncio.to_thread(ffmpeg) → faster-whisper inference
        → stream segments → {type:"complete"} → cleanup
```

State machine at v2.2: **idle → recording → processing → done** (push-to-talk) and **idle → listening → processing → listening** (continuous), with drain-then-done for stop-during-processing. Settings overlay is orthogonal — a separate `settingsOpen: boolean`, not a pipeline state.

---

## Execution Discipline

v2 was gated. No sub-milestone shipped until its pre-conditions were verified:

- **Gate 1** — v2.1 confirmed complete before any v2.2 work began (`60426cc`)
- **Gate 2** — state machine and component architecture diagrams updated for continuous mode before any v2.2 code (`b94c371`). Diagram before code — held.
- **Gate 3** — `@ricky0123/vad-web` installed, COOP/COEP headers verified, `MicVAD.new()` smoke-tested against real mic input; `onSpeechEnd` confirmed to fire with correct `Float32Array` sample counts — all before any orchestration code (`49b9d6e`). The roadmap requirement *"v2.2 does not ship without client-side VAD in place and validated"* was enforced.

---

## v2.0 — Hotkeys + Settings Panel

### Backend

**`GET /models`** — returns the list of models declared in `WHISPER_AVAILABLE_MODELS` (env var), marking which is currently loaded. No auto-discovery; no models appear that aren't explicitly configured.

**`POST /models/swap`** — accepts a model name, acquires the threading lock, loads the new model, frees old VRAM via `gc.collect()` + `torch.cuda.empty_cache()`. If swap fails, old model remains loaded — no degraded state. Implemented as regular `def` (not `async def`) so the endpoint runs in FastAPI's thread pool and keeps the event loop alive for health checks during a multi-second reload.

**Health endpoint update** — `/health` now reports the actual loaded model name, not the config default. Meaningful after any swap.

**Concurrency note** — `swap_model()` acquires the same threading lock that guards `run_inference()`. An in-flight inference holds the lock; swap waits. No deadlock risk — inference completes and releases.

**Backend tests** (`test_models.py`): list returns all available; list marks current; swap success; swap rejects unknown model name; swap is a no-op if same model requested; swap failure leaves old model loaded.

### Frontend

**`useHotkeys`** (`hooks/useHotkeys.ts`) — binds `keydown` on `document`. All bindings use `Ctrl+Shift+<key>` to avoid conflicts with Chrome's built-ins and the editable textarea. Record hotkey (`Ctrl+Shift+Space`) is a no-op while settings panel is open.

| Hotkey | Action |
|---|---|
| `Ctrl+Shift+Space` | Toggle recording |
| `Ctrl+Shift+Y` | Copy transcript |
| `Ctrl+Shift+X` | Clear transcript |
| `Ctrl+Shift+S` | Toggle settings panel |

**`useRecorder` lifted to App** — previously owned by Recorder. Lifted so hotkeys can call `startRecording` / `stopRecording` without prop-drilling through Recorder. Recorder simplified to a presentational component that receives state and a single `onToggle` callback.

**Settings panel** (`features/settings/Settings.tsx`) — slide-out overlay accessible via gear icon or hotkey. Shows available models as radio buttons. States: loading (fetching model list), ready (interactive), swapping (in-progress, radios disabled), error (fetch failed, retry button visible). Record button disabled during swap via `modelSwapping` flag in App. Panel closes via X button, Escape key, or overlay click.

**Frontend tests** (`Settings.test.tsx`): model list renders after load; current model is selected; loading state shown during swap; selection updates on successful swap; error shown on swap failure; close button works; Escape key closes; renders nothing when closed; error state shows retry button.

---

## v2.1 — WebSocket Streaming

### Backend

**`GET /ws/transcribe`** — WebSocket endpoint. Origin checked against `CORS_ORIGINS` before `accept()` — FastAPI's CORS middleware does not cover WebSocket connections; enforcement is in the handler. Audio received as a single binary message after recording stops. Size validated against `MAX_UPLOAD_MB`. ffmpeg runs via `asyncio.to_thread()` — non-blocking, 30-second timeout. faster-whisper segments streamed as `{"type": "segment", "text": "..."}` as each completes. Final `{"type": "complete", ...}` carries the full `TranscribeResponse` payload (raw, cleaned, language, duration, model_name, processing_mode). Temp files cleaned in `try/finally` on all exit paths.

**Concurrency contract** — `swap_model()` can fire mid-segment-iteration. Safe by design: `run_inference()` captures `model = get_model()` at thread start (a strong Python reference). `swap_model()` replaces `_model` and calls `del old_model` — removes only swap's local reference. Python's refcount cannot reach zero while the inference thread's `model` variable is alive. `gc.collect()` and `torch.cuda.empty_cache()` are benign against a live reference. VRAM cleanup defers until inference completes naturally. Model name captured at the same moment as the reference — the response reflects the model that actually ran inference.

**WS message schemas** documented in `schemas.py` (`WsSegmentMessage`, `WsCompleteMessage`, `WsErrorMessage`).

**Backend tests** (`test_transcribe_ws.py`): happy path (segments stream, complete fires); origin rejection (disallowed origin closes connection); oversized payload (rejected after `receive_bytes()`); inference failure (`{type: "error"}` sent, connection closed); swap concurrency contract (model reference held through swap, VRAM cleanup deferred).

### Frontend

**WebSocket as default transport** (`services/api.ts` — `streamTranscribeAudio`). Two failure classes with distinct handling:

| Failure | Cause | Response |
|---|---|---|
| `ws.onerror` | Server unreachable, network dropped | Fall back to `POST /transcribe` |
| `{type: "error"}` | Inference or transcode failed | Surface immediately, no fallback |

**`wsCleanupRef`** — holds the cleanup function returned by `streamTranscribeAudio`. New recording cancels any previous in-flight connection before starting.

**Raw/cleaned comparison toggle** — added to Settings (Display section). `showComparison` backed by `localStorage`, persists across refresh. Transcript component shows raw and cleaned side-by-side when enabled. Useful for ongoing evaluation of the cleanup function's output.

**Frontend tests** (`Settings.test.tsx`, three new): comparison toggle renders unchecked by default; checking it calls `onShowRawComparisonChange(true)`; unchecking calls `onShowRawComparisonChange(false)`.

---

## v2.2 — Continuous Recording Mode

### Infrastructure

**`@ricky0123/vad-web` v0.0.30** — Silero VAD v4, ONNX/WASM, CPU-only, ~4 MB model weight. Energy thresholding was explicitly evaluated and rejected per roadmap; this library uses a trained model that distinguishes speech from background noise and handles quiet speakers.

**COOP/COEP headers** added to `vite.config.ts` — `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Required for `SharedArrayBuffer`, which the ONNX WASM runtime needs for threaded inference. Without these headers the VAD fails to initialize silently.

**Static assets** — `vad.worklet.bundle.min.js`, `silero_vad_legacy.onnx`, `silero_vad_v5.onnx` added to `public/`. ORT WASM binaries served from `node_modules` via `onnxWASMBasePath` — Vite v6 blocks dynamic import of `.mjs` files placed in `public/`; this routing required explicit validation before app code proceeded.

### New Types

`RecordingState` gains `"listening"` — the continuous mode mic-open state. Six pipeline states total.

`RecordingMode = "push-to-talk" | "continuous"` — the new toggle type.

### WAV Encoder (`utils/audio.ts`)

Pure function, no external dependencies. `encodeWavBuffer(samples, sampleRate)` → `ArrayBuffer` — standard RIFF/PCM-16 WAV from Float32Array; 44-byte header; Float32 samples clamped to `[-1, 1]` and scaled to int16. `encodeWav(samples, sampleRate)` → `Blob` wraps with `audio/wav` MIME. `encodeWavBuffer` exposed separately so tests can inspect raw bytes without jsdom's Blob limitations.

**Tests** (`audio.test.ts`, 7): magic bytes (`RIFF`, `WAVE`); header field values (channels, sample rate, bit depth); size invariant (44 + 2×N bytes); clamp behavior at boundary values.

### VAD Hook (`hooks/useVAD.ts`)

Event-driven interface — hook calls App, not the reverse. Opposite direction from `useRecorder`.

- `startListening()` — lazy-initializes `MicVAD.new()` on first call. No ONNX runtime allocated until continuous mode is entered. VAD worklet runs in an `AudioWorklet` off the main thread.
- `stopListening()` — calls `vad.pause()`; instance held for potential future resume.
- `onSpeechEnd(Float32Array)` delivers 16 kHz mono PCM; library resamples internally.
- Stable callback refs via `useRef` — callbacks inside the VAD closure always see the current version, preventing stale captures across renders.
- `destroy()` called on unmount.

**Tests** (`useVAD.test.ts`, 6): `startListening` initializes `MicVAD` and calls `start()`; `onSpeechEnd` fires when VAD fires; `onSpeechStart` fires when VAD fires; `stopListening` calls `pause()` and sets `isListening` false; unmount calls `destroy()`; init failure sets `error`, does not throw.

### Settings Toggle

Recording Mode section added to Settings panel — push-to-talk / continuous radio buttons following the existing model-option pattern. Radios disabled while `isActive` (recording, listening, or processing). `RecordingMode` persisted to `localStorage` and restored on load.

**Tests** (`Settings.test.tsx`, 3 new): default selection is push-to-talk; clicking continuous fires `onRecordingModeChange('continuous')`; radios are disabled when `isActive` is true.

### App Orchestration (`App.tsx`)

The two recording paths are kept strictly separate by design:

**Push-to-talk path** — `audioBlob` effect → `triggerTranscriptionRef.current(blob, append=false)`. A ref (`triggerTranscriptionRef`) is used so the effect doesn't list `triggerTranscription` as a dependency and re-fire on mode changes.

**Continuous path** — `onSpeechEnd → encodeWav → triggerTranscription(blob, append=true)`. Called imperatively, not through an effect, to avoid React's stale-ref problem with repeated blobs.

**`triggerTranscription(blob, append)` — mode dispatch:**

| | `append=false` (push-to-talk) | `append=true` (continuous) |
|---|---|---|
| Previous WS connection | Cancelled | Left in-flight |
| Transcript on start | Cleared | Accumulated |
| `onSegment` updates | Applied (streaming preview) | Skipped (avoids duplication) |
| `onComplete` | Replaces transcript, → done | Appends, → listening |
| On WS connection failure | Falls back to HTTP POST | Surfaces error immediately |

**Paragraph breaks** — `PARAGRAPH_BREAK_MS = 3000`. Gap measured between `onComplete` calls (includes GPU inference latency). `\n\n` inserted when elapsed > threshold and a prior segment exists.

**Drain-then-done** — stop during processing sets `stopRequestedRef.current`. The in-flight transcription completes and lands in the transcript. Next `onComplete` checks the flag and transitions to `done` instead of `listening`. No segment is dropped.

**`isDisabled` logic** — in continuous mode, `isListening=true` during processing keeps Stop active (enabling the drain path). Push-to-talk processing blocks all recording actions.

**Tests** (`App.test.tsx`, 2): normal continuous cycle (VAD fires → encodeWav called → `streamTranscribeAudio` invoked → `onSegment` ignored → `onComplete` appends → transcript present → state returns to listening); drain-then-done (stop during processing → `stopListening` called → segment completes → state is done, not listening).

### Bug Found and Fixed Post-Orchestration (`e1fab21`)

In continuous mode, `onSegment` was appending partial text and then `onComplete` also appended the final cleaned text — every utterance landed twice. Push-to-talk was unaffected (transcript cleared before streaming starts, `onComplete` replaces). Fix: skip `onSegment` updates when `append=true`. Test updated to assert segment ignored in continuous mode and no duplication occurs.

### Diagrams Updated

`state-machine.mmd` — `listening` state added with entry from idle and exits to processing (VAD fires), done (stop), and error (VAD failure). Mode-conditional exit from processing documented.

`component-architecture.mmd` — `useVAD` added as a red (active-mic hook) alongside `useRecorder`, both connected to the Browser mic node.

`privacy-data-flow.mmd` — VAD node added between microphone and blob: silence discarded before any network transit.

---

## Hard Requirements — Compliance Check

These were non-negotiable from v1. All carried forward through v2 without modification.

| Requirement | Status | Notes |
|---|---|---|
| Temp file cleanup via `try/finally` | **Held** | All exit paths — including WebSocket handler on v2.1 |
| Never log transcript content or raw audio | **Held** | No content logged at any level, any transport |
| MIME validation as a separate function | **Held** | `validate_mime_type()` unchanged |
| CORS allowlist both localhost origins | **Held** | Middleware covers HTTP; WS origin enforced in handler |
| MediaRecorder explicit codec + `isTypeSupported()` | **Held** | Push-to-talk path unchanged |
| Request limits (60 s, 10 MB, one file) | **Held** | Enforced on both HTTP and WS routes |
| Diagram before code (v2.0+ state machine changes) | **Held** | Gate 2 enforced for v2.2; v2.0 state machine drawn before settings panel code |
| WebSocket origin enforcement | **Delivered** | CORS middleware does not cover WS — explicit check before `accept()` |
| v2.2 pre-condition gate: VAD validated before continuous mode ships | **Held** | Gate 3 confirmed before any orchestration code |

---

## Explicit Non-Goals (Held)

Nothing from this list was introduced across v2.0–v2.2:

- Async job queues or background workers
- Reverse proxy
- Multi-user deployment
- Any server-side audio or transcript persistence
- Desktop packaging (Tauri — roadmap v3)
- OpenAPI-generated frontend contracts (deferred by design)
- Hotkey reset for manual paragraph break — was listed in the v2.2 roadmap scope alongside silence-based breaks. The passive mechanism (silence-based) shipped; the manual explicit mechanism did not. **→ Scoped into v2.3** by PM decision (see Reviewer Feedback). One binding, one handler, no new state.

---

## Test Coverage

### Backend (pytest)

| File | Tests | Coverage |
|---|---|---|
| `test_health.py` | (v1, unchanged) | `/health` responses, device mode |
| `test_transcribe.py` | (v1, unchanged) | MIME validation, size rejection, temp cleanup |
| `test_models.py` | 6 | Model list, current marking, swap success/failure/noop/invalid |
| `test_transcribe_ws.py` | 5 | Happy path, origin rejection, oversized payload, inference failure, swap concurrency |

### Frontend (vitest)

| File | Tests | Coverage |
|---|---|---|
| `Recorder.test.tsx` | (v1, updated) | State display, toggle callback |
| `Transcript.test.tsx` | (v1, unchanged) | Render, edit, copy, loading state |
| `Settings.test.tsx` | 15 total | Model list/swap/error/retry (9); comparison toggle (3); recording mode (3) |
| `useVAD.test.ts` | 6 | Lifecycle, callbacks, cleanup, init failure |
| `audio.test.ts` | 7 | WAV header, magic bytes, size invariant, clamp |
| `App.test.tsx` | 5 | Continuous cycle, drain-then-done (2); voice command handling — copy, clear, no-op (3) |
| `voiceCommands.test.ts` | 22 | Normalization; exact-segment guard; false-positive cases (mid-sentence, leading/trailing words, multi-word); old scribe-prefix vocab returns null |

### Integration

Smoke test (`ops/scripts/smoke_test.sh`) covers: `GET /health`, `POST /transcribe` (audio round-trip), `GET /models`, `POST /models/swap` (swap to small, verify, swap back). WebSocket path is not covered by the smoke test — this is a known gap.

**CI** — three-job pipeline (frontend typecheck + vitest, backend pytest, Docker build) runs on push and pull request to `main`.

---

## Security Posture

All v1 posture carried forward unchanged. v2 additions:

- **WebSocket origin enforcement** — `CORS_ORIGINS` checked in the handler before `accept()`. The connection is closed with code 4003 (private-use range) on origin mismatch. FastAPI's CORS middleware does not apply to WebSocket — this was an explicit review finding from the v2.1 design and was closed correctly.
- **No new persistence surfaces** — WebSocket streaming is stateless between connections. Segments arrive, stream to the client, and the connection closes. Nothing held server-side.
- **VAD is client-side** — no audio leaves the browser until speech is detected. Silence frames are discarded before any network round-trip. The privacy data flow diagram was updated to reflect this.

---

## Known Limitations and Forward Context

~~**`useVAD` resource leak on repeated start/stop.**~~ **Closed.** `vadRef.current?.destroy()` added before `MicVAD.new()` in `startListening()`. Confirmed by Principal; test added covering repeated start/stop cycle.

~~**`wsCleanupRef` covers only the last in-flight segment in continuous mode.**~~ **Closed (v3 prereq 1, `8cbc933`).** `wsCleanupRef` replaced with `wsCleanupSetRef` (`useRef<Set<() => void>>`). Completed connections deregister via `deregister?.()` calls in `onComplete`, `onConnectionError`, and `onApplicationError` callbacks — the Set does not grow unboundedly during long sessions. On unmount, all in-flight connections are cleaned up. Two new tests verify multi-segment cleanup and stale-entry deregistration. 68 frontend tests total.

~~**`PARAGRAPH_BREAK_MS` timing includes GPU inference latency.**~~ **Closed (v2.3.3, `8cbc933`).** `speechEndTime` captured at `onSpeechEnd` (before inference starts) and threaded through `triggerTranscription`. Paragraph break elapsed and `lastSegmentTimestampRef` update both use `speechEndTime`. Measures time between when the user spoke, not between when the GPU finished. Push-to-talk path unaffected (`speechEndTime` is undefined; `append=false` gates all paragraph break logic).

**WebSocket path not covered by smoke test.** The smoke test exercises HTTP and the model swap endpoint. The WebSocket streaming path is covered by unit tests but has no end-to-end verification script. Natural candidate for v2.3 smoke test expansion.

~~**Hotkey reset not delivered.**~~ **Closed (v2.3.2, `8cbc933`).** Ctrl+Shift+R removed. Automatic paragraph gaps via `lastSegmentTimestampRef` cover the use case. Hotkey system is now 4 bindings (Space, Y, X, S).

~~**Stale `milestone-timeline.mmd`.**~~ **Closed.** v2.2 moved to `section Delivered`.

---

## v2.3 — Pre-delivery scope

> Vocabulary revised in v2.3.1 (copy, clear) before implementation — see roadmap.md.

Voice command vocabulary. Continuous mode (v2.2) is the required prerequisite and is now in place.

- Fixed phrases: **Stop**, **Submit**, **Redo**, **Clear**
- Implementation surface: `onSegment` callback in `triggerTranscription` — string match against incoming segment text before display
- Matched phrases stripped from transcript output
- No backend changes expected
- Ship fixed phrases first; evaluate false positive rate in real dictation before adding configurability

**Pre-v2.3 close-out items** (see Reviewer Feedback section for resolution):
1. ~~Fix `useVAD` resource leak~~ — **closed.**
2. ~~Update `milestone-timeline.mmd`~~ — **closed.**
3. ~~Hotkey reset scope decision~~ — **closed.** Scoped into v2.3 by PM.
4. WebSocket smoke test — optional, not blocking v2.3.
5. ~~`wsCleanupRef` continuous mode gap~~ — **closed.** Set pattern shipped as v3 prereq 1.

---

## Reviewer Feedback — April 4, 2026

### Principal Reviewer

> *"The delivery is accepted. v2.0 through v2.2 shipped as scoped. The architecture held. The hard requirements held. Scope was clean. The report is thorough and accurate."*

**Requirement verification** — Principal mapped every stated hard requirement back to the code. Temp cleanup in `try/finally` on all paths including the new WebSocket handler — confirmed. No content logging — confirmed. MIME validation unchanged — confirmed. CORS on HTTP, origin enforcement on WS before `accept()` — confirmed. `MediaRecorder` codec constraint unchanged — confirmed. Request limits enforced on both transports — confirmed. Diagram-before-code discipline held for v2.2 — gate commits verify it.

**Concurrency contract** — `transcribe_ws.py` lines 119–123 correctly capture both `model` and `current_name` at the top of `run_inference()` before yielding to segment iteration. Confirmed closed.

**Factual correction** — WebSocket close code on origin mismatch is 4003 (private-use range), not 1008. Corrected in this report and confirmed in `transcribe_ws.py` line 42.

**`useVAD` resource leak** — confirmed in code, confirmed as a completion task violating the resource cleanup standard. Closed: `vadRef.current?.destroy()` added before `MicVAD.new()` in `startListening()`. Test added.

**`wsCleanupRef` gap in continuous mode** — `wsCleanupRef.current` is overwritten on every `triggerTranscription` call; only the most recent WebSocket's cleanup survives. Low-risk in practice (connections close naturally on `complete`), but the guarantee is incomplete. Carried as context for v2.3. If concurrent segment count grows, a cleanup array is the right pattern.

**Speaker diarization parking lot entry** — framing accepted. Client-side ONNX gate, `localStorage` embeddings, no backend changes. Design review required before any milestone entry. Principal notes: when the time comes, start with the failure mode — a mis-calibrated threshold filtering the user's own voice is worse than transcribing all voices.

### PM

> *"Delivery is clean. Three milestones executed in sequence, gated correctly at each boundary, with hard requirements and non-goals held throughout. The compliance table is auditable."*

**Hotkey reset — scoped into v2.3.** Silence-based paragraph breaks are passive; hotkey reset is the manual equivalent. Voice commands (`Clear`, `Redo`) cover full-buffer semantics, not mid-stream paragraph insertion — distinct capabilities. Hotkey reset belongs alongside voice commands as extensions of the same continuous mode interaction model. Scope constraint from PM: one hotkey binding (`Ctrl+Shift+R`, or reviewed with UX), inserts `\n\n` into the accumulation buffer and resets `lastSegmentTimestampRef`. Not a new state. Not a new settings entry. One line in `useHotkeys`, one handler in `App`.

**State Machine slide text** — PM flagged that the prose frame (lines 730–751 of `main.tex`) may not mention `listening`. Verified against current file: line 732 reads "six recording pipeline states" and the `listening` bullet is present at line 738. Already corrected in the v2.2 presentation commit (`d08613e`). No further action needed.

**Milestone timeline diagram** — confirmed non-optional before onboarding use. Closed: v2.2 moved to `section Delivered`.
