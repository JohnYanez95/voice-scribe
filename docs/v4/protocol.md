# Voice Scribe v4 Streaming Protocol — Version 1

Status: **locked at design review, 2026-07-31**. This document is the acceptance surface for
v4.0: every session test in `apps/api/tests/test_stream_ws.py` names the clause it enforces.
Changing anything in here after v4.1 ships is a coordinated release with downstream consumers;
changing the backend loop behind it is not. That asymmetry is why this document exists.

Review provenance: fresh-context adversarial reviews by Principal (protocol contract), Senior
Engineer (commit policy + implementation risk, with live decode-cost measurements on the target
GPU), and PM (scope, limits, compliance). All three review outputs are reflected here; the
resolved open questions are recorded in `roadmap.md` (v4 section).

---

## 1. Transport and session lifecycle

- **C1.1** Endpoint: `WS /ws/stream`. Supplements `/ws/transcribe` (one-shot) and
  `POST /transcribe` (HTTP fallback); neither is changed.
- **C1.2** Origin enforcement: same allowlist as `/ws/transcribe`. Disallowed origin → close
  **4003** *before* accept. Contract note: browsers surface a pre-accept close as a generic
  connection failure — client fallback logic must not depend on reading this code.
- **C1.3** One active session per server. A second connection while the slot is held is
  **accepted**, then sent `error{code:"busy", fatal:true}`, then closed with **4409**.
  (Post-accept so the client can observe the code; pre-accept closes are invisible — see C1.2.)
- **C1.4** Preemption: if the incumbent session has received no binary frames for ≥ 2 s
  (`PREEMPT_GRACE_S`), a new connection preempts it — the incumbent gets
  `error{code:"preempted", fatal:true}` + close 4409, the newcomer proceeds. An actively
  streaming incumbent is never preempted.
- **C1.5** Idle timeout: a session that has received no frames and no control messages for
  `SESSION_IDLE_TIMEOUT_S` (10 s) is torn down server-side (`error{code:"session_timeout",
  fatal:true}` + close). This — not TCP keepalive — is what frees the slot after a client crash.
- **C1.6** Session wall-clock ceiling: `MAX_SESSION_S` (1800 s). Exceeded → implicit flush,
  `final`, `error{code:"session_timeout", fatal:true}`, close.
- **C1.7** Slot release ordering: the session slot is released in a `finally:` on the handler,
  and only after the decode task has observed cancellation. Releasing the slot while a decode
  is mid-tick would let two sessions contend for the GPU.
- **C1.8** Normal close: server-initiated close **1000** after the `stop` sequence (C3.5).

## 2. Binary frames (client → server)

- **C2.1** Sample format: **`pcm_f32le`** — 32-bit float, little-endian, mono, 16 000 Hz.
  Chosen over s16le because it is the native output of the client capture path
  (`Float32Array`) and the native input of faster-whisper; localhost bandwidth is not a
  constraint. `sample_format` and `sample_rate` are required fields of `start`; the server
  rejects any value it does not implement (`error{code:"unsupported_format", fatal:true}`) —
  it never coerces.
- **C2.2** Frame validity: byte length must be a nonzero multiple of 4 and ≤ `MAX_FRAME_BYTES`
  (65 536 = 1.024 s of audio). Violation → `error{code:"frame_too_large"|"protocol_violation",
  fatal:true}` + close, checked before any buffering. Empty (0-byte) frames are a protocol
  violation.
- **C2.3** NaN/Inf sanitization: non-finite samples are replaced with 0.0 on ingest. A single
  NaN otherwise poisons the whole decode window and presents as a model-quality bug.
- **C2.4** Frames before `start` or before the server's `ready`: protocol violation (fatal).
  Frames after `stop`: dropped silently and counted (count reported in the `stop` ack).
- **C2.5** Ingest rate: sustained ingest above 2× real-time for 5 consecutive seconds is a
  protocol violation (fatal). The wire is a live capture path, not a file upload — bulk replay
  belongs to the one-shot endpoints.
- **C2.6** Client-side VAD gating at the source remains the invariant (v2.2): silence is not
  sent. The server does not run `vad_filter` on this path (see C7.6).

## 3. Control messages (client → server, JSON text)

- **C3.1** `{"type":"start", "protocol_version":1, "sample_format":"pcm_f32le",
  "sample_rate":16000, "language":"en"?}` — opens the session. `language` optional; if absent
  the language detected on the first successful decode is pinned for the session (C7.7).
- **C3.2** Unknown `protocol_version` → `error{code:"unsupported_version", fatal:true}` + close.
  Version 1 is this document. The protocol version is independent of the contract-doc release
  tag: the stream protocol iterates faster, and conflating them would force fake major bumps.
- **C3.3** `{"type":"flush"}` — **utterance boundary, not session end.** Client VAD sends this
  at each speech end. Server: cancel any in-flight tick decode, decode the remaining
  uncommitted buffer once, emit `final`, bump `utterance_id`, clear per-utterance state
  (buffer, prev-hypothesis, holdback counter), keep the session and the connection alive.
  Silence is ground truth; no agreement is needed on the flush decode.
- **C3.4** Forced flush: `MAX_UTTERANCE_S` (120 s) of received audio without a client `flush`
  triggers a server-side flush (`final` carries `"forced": true`). Bounds the no-VAD-signal
  pathological case.
- **C3.5** `{"type":"stop"}` — session end. Implicit flush (if uncommitted audio), then
  `ack{of:"stop"}`, then server close 1000.
- **C3.6** `{"type":"reset"}` — destructive: drops the uncommitted buffer **and** the committed
  state of the current utterance, bumps `utterance_id`, emits `ack{of:"reset"}`, emits no
  `final`. The client must discard rendered committed text for that `utterance_id` — otherwise
  reset has no observable effect. (This is the primitive the `clear` voice command will use;
  `clear` itself is confirmed only on `final` — see roadmap open question 2, resolved.)
- **C3.7** Malformed JSON, unknown `type`, or out-of-order control (`flush` before `start`,
  second `start`) → `error{code:"protocol_violation", fatal:true}` + close.

## 4. Server → client messages

All server messages carry `seq` (monotonic per session, starting at 1) and, where meaningful,
`utterance_id` (starting at 0, bumped by flush/forced flush/reset). Client rule: discard any
message whose `utterance_id` is below the current one.

- **C4.1** `ready` — sent in response to `start`, before any other message. Carries
  `protocol_version`, `session_id`, `sample_rate`, `sample_format`, `max_frame_bytes`,
  `model_name`, `language` (null until pinned), and the tunables in force: `decode_tick_ms`,
  `max_uncommitted_s`, `max_holdback_ticks`. The client MUST NOT send binary frames before
  `ready`. `stream_bench` records this echo so every measurement is attributable to the
  tunables that produced it.
- **C4.2** `partial` — `{type, seq, utterance_id, text}`. **`text` is a full replacement of the
  entire tentative tail** for the current utterance — never an append. Retractable by the next
  `partial`. Downstream consumers: `partial` must never be persisted, copied to the clipboard,
  fed to a transform, or used to trigger an action.
- **C4.3** `committed` — `{type, seq, utterance_id, text, t0, t1, forced}`. `text` is the
  **newly committed words only** (append-only delta). `t0`/`t1` are offsets in *received-audio
  seconds within the current utterance* — explicitly not wall clock: client VAD elides silence,
  so the audio timeline and the wall clock diverge. `forced` marks a holdback force-commit —
  a content-free flag so the gate's force-commit rate is measurable by `stream_bench` from the
  client side (the server gains no instrumentation hooks). Committed text is never revised by
  any later message (C5).
- **C4.4** `final` — `{type, seq, utterance_id, raw, cleaned, language, duration, model_name,
  processing_mode, dropped_audio_ms, forced}`. Same consumer-facing fields as today's
  `complete`, plus the last two. `duration` is total received-audio seconds for the utterance,
  computed from frame count — not from the decoder's `info` (a flush decode of the tail would
  report only the tail). `final` is also the client's release signal: a client retaining
  utterance PCM for fallback (v4.1) may drop it on `final` for that `utterance_id`.
- **C4.5** `error` — `{type, seq, code, detail, fatal}`. `code` is the stable, machine-readable
  surface (Pydantic `Literal`, exported in the contract schema); `detail` is human-readable and
  explicitly unstable — clients must not parse it. `fatal:true` → session over, degrade;
  `fatal:false` → session continues. Codes: `busy`, `preempted`, `protocol_violation`,
  `frame_too_large`, `unsupported_format`, `unsupported_version`, `model_swapping`,
  `decode_failure`, `overrun`, `session_timeout`.
- **C4.6** `ack` — `{type, seq, of:"stop"|"reset", utterance_id}`. For `stop`, includes
  `frames_dropped_after_stop`.

## 5. The commitment contract (the invariants that make "zero retraction" honest)

- **C5.1** `committed` is append-only within an utterance. Formally: a retraction is any server
  message whose effect, under the reconciliation rules above, is that the client displays
  different committed text for a given `(utterance_id, offset)` than it displayed before.
  `stream_bench` verifies zero retractions by replaying the message log through a reference
  reducer — not by inspection.
- **C5.2** The flush decode covers the **uncommitted buffer only**. Committed audio is trimmed
  at each commit and is never re-decoded — an invariant of the flush, not just of the tick.
- **C5.3** `final.raw` MUST carry the utterance's concatenated committed text as a **literal
  prefix**. Asserted by `stream_bench` on every utterance.
- **C5.4** `cleaned` is a display derivation available only on `final`; `committed` carries raw
  text. The committed→cleaned difference is capitalization and whitespace only
  (`clean_transcript()` semantics) — never different words.
- **C5.5** Every element of the commit policy either commits or withholds — **none of them
  revises.** The per-word probability floor and the edge guard only withhold; LocalAgreement
  only commits; force-commit (holdback ceiling) only commits. Force-commit therefore preserves
  the zero-retraction invariant while weakening the *quality* claim for the affected words —
  it converts a visible flicker into a possible invisible permanent error. That trade is
  deliberate (output lands in an editable textarea) and is why the gate also measures
  force-commit rate and committed-vs-one-shot WER, not just retractions (see roadmap gate).
- **C5.6** Overrun honesty: if the buffer would exceed its cap with no commit available, the
  server slides and drops the **oldest** uncommitted audio, never the newest, never silently:
  first drop in an utterance emits `error{code:"overrun", fatal:false}`, and `final` carries
  cumulative `dropped_audio_ms`. `stream_bench` gate runs require `dropped_audio_ms == 0`.

## 6. Limits (streaming path)

The 60 s / 10 MB / one-file limits are per-request limits on the one-shot paths and do not
apply to `/ws/stream`. The streaming path is bounded by:

| Limit | Value | Enforcement |
|---|---|---|
| `MAX_FRAME_BYTES` | 65 536 | fatal error + close, pre-buffering (C2.2) |
| `MAX_UNCOMMITTED_S` | 24 s | slide + overrun signal (C5.6) |
| `LEFT_CONTEXT_S` | 3 s | window planner invariant (C7.1) |
| `MAX_UTTERANCE_S` | 120 s | forced flush (C3.4) |
| `MAX_SESSION_S` | 1800 s | flush + fatal error + close (C1.6) |
| `SESSION_IDLE_TIMEOUT_S` | 10 s | teardown, frees the slot (C1.5) |
| Ingest rate | ≤ 2× real-time | fatal after 5 s sustained (C2.5) |

Memory bound, stated for compliance review: at most `LEFT_CONTEXT_S + MAX_UNCOMMITTED_S` = 27 s
of float32 mono 16 kHz audio ≈ **1.7 MB** exists in memory per session at any instant.
Preallocated, never serialized, never written to disk, released on close, disconnect, and error
alike. Session length is unbounded in wall clock; audio retention is bounded in bytes. The
correct claim is "bounded", not "brief".

## 7. Serving policy (server-internal; here because tests cite it)

- **C7.1** Window invariant: `LEFT_CONTEXT_S (3.0) + MAX_UNCOMMITTED_S (24.0) + SAFETY_S (3.0)
  ≤ 30.0` — Whisper's `pad_or_trim` silently truncates past 30 s, so the planner enforces this
  at session start and per tick. (The former `MAX_BUFFER_S = 28` was renamed and re-derived at
  review: 28 + 3 s of left context exceeded the window and would have silently dropped tail
  audio.)
- **C7.2** Left context is carried as **audio**, and its re-decoded words are suppressed **by
  timestamp** (`word.end` inside the left-context region), never by string matching. All
  hypothesis comparison happens in absolute sample coordinates (session clock), so hypotheses
  from different window positions align.
- **C7.3** Agreement (LocalAgreement-2): longest common prefix of the two most recent
  hypotheses, compared on a normalized key (NFKC → casefold → strip edge punctuation, keep
  word-internal apostrophes/hyphens); the **raw surface form from the newer hypothesis** is
  what gets committed. A word is commit-eligible only if non-terminal in both hypotheses
  (terminal words carry unstable punctuation/casing).
- **C7.4** Vetoes (withhold-only): per-word probability floor `WORD_PROB_FLOOR = 0.5`
  (requires `word_timestamps=True`), and edge guard `EDGE_GUARD_S = 0.6` — never commit a word
  whose end lies within 0.6 s of the buffer end. The former segment-level
  `COMMIT_LOGPROB_FLOOR`/`NO_SPEECH_MAX` knobs were removed at review: at their stated values
  they duplicated faster-whisper's internal defaults (near-dead code), and segment-mean
  logprob cannot protect a word-level commit. Truncation hallucinations agree across ticks
  with *good* logprobs; the edge guard is the structural defense.
- **C7.5** Holdback: `MAX_HOLDBACK_TICKS = 6`, **frontier-anchored** — the counter keys on the
  commit-frontier position and resets only when the frontier advances (a global or
  changed-hypothesis reset either starves or never fires).
- **C7.6** Decode settings on this path: `word_timestamps=True`, `vad_filter=False` (server-side
  re-segmentation destabilizes agreement across ticks; the client gates at the source),
  `condition_on_previous_text=False` for tick decodes. Cost note on word timestamps:
  faster-whisper derives them via DTW over decoder cross-attention — O(tokens × audio frames)
  *per decode window*, measured at ~+15% per decode. The window invariant (C7.1) caps the
  window at ≤ 30 s, so this quadratic term is bounded by a constant and never grows with
  session length. Segment-level timestamps were rejected at review as ±0.5 s in practice —
  too coarse for the trim/suppression arithmetic (C7.2). The commit comparison itself is a
  linear longest-common-prefix over normalized tokens; DTW plays no part in word *matching*.
- **C7.7** Model and language are pinned per session: the decode loop resolves `get_model()`
  once at `start` and holds that reference; language comes from `start` or the first decode
  and is passed explicitly to every subsequent decode. Per-tick auto-detect on short buffers
  flips languages mid-utterance and presents as a commit stall.
- **C7.8** Backpressure (three rules): (1) one decode in flight per session, guarded by a
  decode lock — ticks never queue; (2) next tick at `max(now, tick_start + DECODE_TICK_MS)`,
  overrun increments `ticks_skipped`; (3) if `decode_ms > DECODE_TICK_MS` for 3 consecutive
  ticks, double the effective tick interval (cap 4×), log once.
- **C7.9** Flush ordering: `flush` sets the cancel event first; the in-flight tick drains at
  the next segment boundary and its hypothesis is discarded; then the flush decode takes the
  lock. Flush latency = cancel drain + one decode; `stream_bench` reports the drain separately.
- **C7.10** Idle ticks: skip when uncommitted audio < `MIN_DECODE_S` (1.0 s) or no frames
  arrived since the last tick (near-silence decodes are Whisper's most reliable hallucination
  trigger). The first tick of an utterance fires as soon as 1.0 s is buffered rather than
  waiting for the grid — this is what keeps first-partial ≤ 1.5 s at a 750 ms tick.
- **C7.11** Non-space-delimited languages (ja, zh, th): incremental word-prefix commit is
  scoped out for v4 — sessions pinned to such a language run **flush-only** (partials shown,
  commits only at flush). Whitespace tokenization would treat an utterance as one word.
  Revisit alongside the language-tutor project with a proper segmenter; recorded in the
  roadmap so it is not discovered during Japanese pronunciation practice.

## 8. Concurrency with `/models/swap`

- **C8.1** One module-level guard (single lock) covers both flags: `stream_active` and
  `swap_in_progress`. Swap while a stream is active → HTTP **409** from `/models/swap` (new
  contract row — the error table previously listed only 400/500). Stream `start` while a swap
  is in progress → `error{code:"model_swapping", fatal:true}` + close. Both checks and flag
  sets happen under the same lock — the two-flag/two-lock version is a TOCTOU race.
- **C8.2** `stream_active` is cleared in `finally:` on every session exit path. A crashed
  session that leaves it set bricks streaming until restart — and the second-session-rejection
  test would pass while hiding it.
- **C8.3** Stated reason for the 409 (contract text): a streaming session holds its model
  reference for the session's lifetime, so a mid-stream swap means double VRAM for minutes,
  not for one inference.

## 9. Privacy

- **C9.1** No temp files on this path — ever. The kill-mid-inference temp-file residue warning
  in the contract's operational notes does not apply to `/ws/stream`; there is no residue to
  survive a kill. This is the strongest form of the zero-persistence claim and the contract
  states it explicitly.
- **C9.2** No transcript, hypothesis, or audio content in any server log line at any level.
  The debugging surface for the commit policy is `stream_bench` — a WebSocket *client* that
  sees everything on the wire. Its committed artifacts carry counters, latencies, and
  distributions only; any text diffing stays in memory or goes to a gitignored path, sourced
  from committed synthetic fixtures, never user audio.

## 10. Fallback and degradation (policy now, client implementation v4.1)

- **C10.1** Degrade ladder: `/ws/stream` failure → one-shot `/ws/transcribe` for the remainder
  of the session; the existing one-shot → HTTP POST fallback (v2.1) is unchanged beneath it.
- **C10.2** By error code: failure before `ready`, or `code ∈ {busy, preempted,
  unsupported_version, session_timeout}` → degrade. `code == decode_failure` → surface the
  error, do not fall back (the same failure recurs on the one-shot path). Same
  application-vs-connection split v2.1 established.
- **C10.3** Client retains the current utterance's PCM until `final` for that `utterance_id`
  (C4.4), so a mid-utterance stream failure can replay the utterance through the one-shot
  path instead of losing it. Protocol constraint now; client code v4.1.

## 11. Contract artifact obligations (v4.0, not deferrable)

- **C11.1** All server→client message models and the `start` control model are Pydantic models
  in `app/schemas.py`, registered in `export_contract.py`'s `CONTRACT_MODELS`, in the same
  commit that defines them.
- **C11.2** A guard test asserts every `Ws*` class in `app.schemas` appears in
  `CONTRACT_MODELS` — the drift test alone detects file-vs-code drift, not code-vs-reality
  drift.
- **C11.3** `docs/contract/runtime-contract.md` edits: transport table corrected (ffmpeg
  transcode is not universal — the streaming path takes PCM directly), per-transport hard-limit
  rows (§6), close codes 4409/1000, error-code enum, `partial`/`committed`/`final` consumer
  guidance (C4.2–C4.4), privacy section per §9, `final.duration` provenance (C4.4). Schema
  regenerated; drift test green.

---

## Amendments — post-implementation peer review, 2026-07-31

Wire-visible behavior is unchanged; these tighten server-internal clauses the review found
underspecified, and record clause-vs-implementation gaps deferred to v4.1. Protocol version
stays 1.

- **C7.2 (tolerance):** frontier suppression — both the left-context suppression and the
  commit-frontier filter — applies a tolerance of one decoder frame
  (`FRAME_TOLERANCE_S = 0.02`): a word ending within 20 ms *after* the boundary is treated as
  re-decoded committed audio. Re-decodes from a different window position re-time words by up
  to one frame; without the tolerance, a committed word whose end drifts later duplicates
  permanently, invisibly to the retraction reducer.
- **C7.4 (anchor):** the edge guard is measured against the end of the audio actually handed
  to the decoder (snapshot at decode start), not the live buffer end — frames arriving during
  a decode must not erode the guard.
- **C7.9 (drain cost):** faster-whisper's lazy segment iterator runs the full decode on the
  first `next()` for single-segment windows (the common case at ≤ 30 s), so the "cancel drain"
  is in practice one full tick decode. Flush latency budgets must assume
  drain ≈ one decode, not ≈ one segment boundary.
- **Flush window (C5.2 + C7.1):** the flush decode window is planned like a tick window:
  after an overrun it starts at the effective (slid) edge — audio reported dropped is never
  decoded — and is therefore bounded by `MAX_UNCOMMITTED_S`, never by `MAX_UTTERANCE_S`.
- **Flush decode floor:** flush decodes shorter than `MIN_FLUSH_DECODE_S = 0.1 s` are skipped
  (sub-frame tails reliably hallucinate); the `final` still fires with committed text.

**Deferred to v4.1 (clause-vs-code reconciliation, to settle with the client design):**
- **C2.4** second half: the frames-after-`stop` counter is structurally always 0 in the current
  single-pass stop handling — either drain briefly before the ack or drop the field.
- **C2.5**: implemented as a cumulative lead allowance (`received > 2 × elapsed + 10 s`), not a
  5 s sliding window. Amend the clause or implement the window.
- **C4.6**: pin which `utterance_id` the `stop` ack carries (reset acks the closed utterance;
  stop currently acks the post-bump id).
- **Close-code taxonomy:** 4408/4409 are coarse buckets; `error.code` is the classification
  surface (now stated in the contract doc). Decide at v4.1 whether `session_timeout` and
  `model_swapping` deserve distinct close codes.
