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
  Frames after `stop`: dropped silently. *(v4.1 amendment: the per-count report field was
  removed — single-pass stop handling made it structurally 0, and draining just to count
  would add stop latency for a number no client reads. Removal is legal because the contract
  is untagged `v4.0-dev`; post-release this would be a major bump. Client rule: `sendAudio`
  after `stop` is an explicit no-op.)*
- **C2.5** Ingest rate: cumulative received audio may lead real time by at most
  `BURST_CREDIT_S` (10 s): `received_s > elapsed_s + BURST_CREDIT_S` is a protocol violation
  (fatal). The wire is a live capture path, not a file upload — bulk replay belongs to the
  one-shot endpoints. *(v4.1 amendment: the previous "2× real-time" form let legal lead grow
  without bound over a long session — with keepalive making long pauses routine, a client
  could bank minutes of instantaneous replay credit. The fixed credit covers what it is for:
  the ~0.9 s pre-roll replay at speech onset, startup jitter, and wire-frame batching. The §6
  memory bound holds under either form; the exposure was decode thrash, not memory.)*
- **C2.6** Client-side VAD gating at the source remains the invariant (v2.2): silence is not
  sent. The server does not run `vad_filter` on this path (see C7.6). *(v4.1 note — sanctioned
  exceptions, deliberate: (1) the `preSpeechPadMs` pre-roll replay sends up to ~0.9 s of
  pre-speech audio at each onset — it exists because Silero clips onsets; (2) intra-utterance
  sub-redemption silence may be sent when speech resumes, to keep the server's audio timeline
  contiguous. C2.6 forbids* sustained *silence streaming — the redemption tail is gated
  client-side (at most ~0.2 s of trailing silence reaches the flush decode), because a
  multi-second silent flush window is Whisper's most reliable hallucination trigger.)*

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
- **C3.8** *(added v4.1 — idle-timeout/keepalive decision)* `{"type":"ping"}` — keepalive.
  Legal only between `ready` and `stop`; pre-`start` it is a protocol violation (C3.7).
  Receipt alone resets the C1.5 idle timer; there is no ack. A client MUST send pings only
  when the `ready` message carried `idle_timeout_s` (absent on a v4.0 server — pinging one
  would be fatal under C3.7; presence is the capability signal), SHOULD derive its period
  from that value (`idle_timeout_s / 3`), and SHOULD suppress pings while frames are flowing.
  Ping does **not** reset the C1.4 preemption grace (which keys on binary frames — a
  pinging-but-silent session stays preemptable; deliberate, do not "fix" it) and has no
  effect on C2.5 accounting or the C1.6 ceiling.
  **Decision rationale, recorded:** the alternatives were a longer idle timeout and
  fresh-session re-establishment on `session_timeout`. A longer timeout's real cost is
  C8.1/C8.3 — a dead session holds `stream_active`, 409-ing `/models/swap` and pinning the
  model reference for the whole window (C1.4 preemption already covers slot *contention*).
  Re-establishment reintroduces the per-pause WS churn v4.1 exists to eliminate and collides
  with C10.2's session_timeout→degrade mapping. Ping preserves the 10 s crash-recovery
  teardown exactly: a crashed client stops pinging.
  **C1.6 interaction:** with keepalive, the 1800 s wall-clock ceiling becomes reachable in
  continuous dictation. The client therefore *rotates* the session (close 1000 via `stop`,
  fresh handshake) at 1500 s, at an inter-utterance boundary (`listening`, no outstanding
  flush) — invisible to the user. A ceiling `session_timeout` that still slips through
  degrades per C10.2.

## 4. Server → client messages

All server messages carry `seq` (monotonic per session, starting at 1) and, where meaningful,
`utterance_id` (starting at 0, bumped by flush/forced flush/reset). Client rule: discard any
message whose `utterance_id` is below the current one.

- **C4.1** `ready` — sent in response to `start`, before any other message. Carries
  `protocol_version`, `session_id`, `sample_rate`, `sample_format`, `max_frame_bytes`,
  `model_name`, `language` (null until pinned), and the tunables in force: `decode_tick_ms`,
  `max_uncommitted_s`, `max_holdback_ticks`, `idle_timeout_s` *(added v4.1 — the C3.8
  keepalive capability signal and the value the client derives its ping period from)*. The
  client MUST NOT send binary frames before `ready`. `stream_bench` records this echo so
  every measurement is attributable to the tunables that produced it.
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
- **C4.6** `ack` — `{type, seq, of:"stop"|"reset", utterance_id}`. **Uniform rule (v4.1):**
  the ack carries the `utterance_id` in force *after* the control was applied (post-bump for
  both stop and reset — reset was changed to match, so the client's stale-id filter adopts
  the acked id directly with no `+1` inference). The former `frames_dropped_after_stop`
  field was removed (see C2.4).

## 5. The commitment contract (the invariants that make "zero retraction" honest)

- **C5.1** `committed` is append-only within an utterance. Formally: a retraction is any server
  message whose effect, under the reconciliation rules above, is that the client displays
  different committed text for a given `(utterance_id, offset)` than it displayed before.
  `stream_bench` verifies zero retractions by replaying the message log through a reference
  reducer — not by inspection.
- **C5.2** *(corrected 2026-08-02 — see that amendments block)* Committed audio is never
  re-**committed**; bounded re-**decode** of committed left context is by design on both
  paths. Tick windows open `left_context_s` before the frontier and `localize()` suppresses
  re-decoded committed words by timestamp; the flush window opens `flush_left_context_s`
  before the frontier under the same suppression, plus the C7.12 seam guard. (The original
  "never re-decoded" wording was false for the tick path by design, and it justified
  building the flush window with no left context — which produced the frontier-residual
  duplicate the 2026-08-02 field test observed.)
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
- **C7.3** Agreement (LocalAgreement-2 — the policy is Liu, Spanakis & Niehues,
  Interspeech 2020, applied to Whisper by Macháček et al. 2023; see
  [`../references.md`](../references.md). Everything below the first sentence is this
  implementation's own and is evidenced in the amendment blocks): longest common prefix
  of the two most recent hypotheses, compared on a normalized key (NFKC → casefold → strip edge punctuation, keep
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
- **C10.2** *(rewritten v4.1 as a default rule, not an enumeration)* Failure before `ready`,
  or any fatal error with `code !== "decode_failure"` — **including codes unknown to the
  client** (forward compatibility) — → degrade. `code == decode_failure` → surface the
  error, do not fall back (the same failure recurs on the one-shot path). Same
  application-vs-connection split v2.1 established. Notes: the client-bug classes
  (`protocol_violation`, `frame_too_large`, `unsupported_format`, `unsupported_version`)
  degrade *silently* — loud `console.error`, never a user-facing error state (losing
  dictation is worse than a spurious one-shot). `model_swapping` is transient but still
  degrades for the remainder of the session per C10.1 — deliberate, not a bug; a fresh
  continuous activation tries streaming again.
- **C10.3** *(amended v4.1)* Client retains the PCM of **each flushed-but-unfinalized
  utterance** until its `final` (C4.4) — in continuous dictation the user may start
  utterance N+1 while N's `final` is outstanding, so the retention surface is a FIFO, not a
  single buffer. Bound, stated §6-style: at most 8 entries, drop-oldest with a loud
  `console.error` (worst case 8 × ≤ 120 s float32 mono 16 kHz ≈ 58 MB; realistic depth is
  0–1 entries of a few seconds). Deleted on `final` for that `utterance_id`, on degrade
  (after replay through the one-shot path), and on session end. The *in-progress* utterance
  is not separately retained: the client relies on vad-web's internal segment accumulation
  to re-deliver the full utterance at `onSpeechEnd` — this reliance is load-bearing and
  becomes real per-frame retention if the capture source ever changes.

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

**Deferred-to-v4.1 reconciliations — resolved 2026-08-01 (v4.1 step 2; wire-visible changes
carry the C11 obligations in the same commit):**
- **C2.4** — resolved: field dropped (see amended C2.4). Structurally 0; draining to count
  buys nothing at the cost of stop latency.
- **C2.5** — resolved by code change, the third option: neither the doc's sliding window nor
  the implemented unbounded-lead form survives keepalive; the clamp
  (`received > elapsed + BURST_CREDIT_S`) is two lines and kills the accumulation while
  keeping the pre-roll burst legal (see amended C2.5).
- **C4.6** — resolved: uniform post-bump rule; reset changed to match stop (see amended C4.6).
- **Close-code taxonomy** — **closed decision, not a deferral:** 4408/4409 stay coarse.
  `error.code` is the single classification surface; C1.2 already forbids clients from
  keying on close codes, and distinct codes would create a second surface to get wrong.
  Do not reopen at v4.2.

**First-partial measurement anchor (v4.1 field-test-review addition (3), pinned here):**
the gate number (`stream_bench`, roadmap gate list) is measured from **`first_frame_sent`**
on the client wire clock — backend-comparable, and the clock the v4.2 tunables
(`STREAM_MIN_DECODE_S`, tick interval) actually move. The user-perceived number is a
separate, additive client-side figure: wire number **plus VAD detection lag** (measured by
the v4.1 spike harness) **minus the pre-roll head start** — the ~0.9 s pre-roll burst
front-loads `MIN_DECODE_S` (C7.10), so the first tick fires after ~0.2 s of live speech
rather than 1.0 s; the sign matters because the v4.2 `STREAM_MIN_DECODE_S 1.0 → 0.8`
projection was computed without it. Reports carry `first_partial_anchor` so every number is
attributable to its clock.

## Amendments — interactive field-test review, 2026-08-02

Wire-visible behavior unchanged (no C11 obligation; protocol version stays 1). Forced by
the live real-mic finding: adjacent-word duplicates at flush boundaries ("very Very",
~1 per VAD pause; harness classification: 3 of 8 flushes intra-`final`, 0 inter-`final`).

- **C5.2 corrected** (inline above): the "never re-decoded" claim was false for the tick
  path by design and justified a flush window with no left context — the root cause of the
  duplicates. The invariant is *never re-committed*.
- **C7.12 (new) — flush seam.** The flush decode window opens `flush_left_context_s`
  (default 1.0 s; env `STREAM_FLUSH_LEFT_CONTEXT_S`; must not exceed `left_context_s`, the
  retention bound) before the commit frontier and is localized against the frontier, the
  same shape as a tick. After localization, `suppress_seam_duplicate()` (pure function,
  `stream_policy`) drops the **leading** tail word iff it `normalize_token`-equals the last
  committed word **and** starts within `seam_tolerance_s` (default 0.10 s; env
  `STREAM_SEAM_TOLERANCE_S`) of the frontier — at most one word per flush. Rationale: the
  frontier is a DTW word-end estimate that lands early, so the window otherwise opens on
  the last committed word's residue, which a context-free decode re-emits sentence-initial.
  **Accepted residual risk:** a genuine immediate repeat whose second copy starts inside
  the tolerance is indistinguishable by any local rule and is dropped (cf. C5.5's
  deliberate-trade form). Suppressions are counted (`seam_suppressions` on the
  session-close line; `seam_suppressed` per flush) — counters only, never content (C9.2).
- **C7.9 note:** the flush decode window grew by `flush_left_context_s`; the finalization
  budget now includes it. Measured post-fix on the seam probe before/after: p50 0.319 → see
  roadmap v4.1 record for the recorded deltas.
- **Flush decode floor scope:** `MIN_FLUSH_DECODE_S` applies to the **uncommitted tail**,
  not the window — left context alone must never trigger a decode.
- **Capture-side (C2.6 companion, `useVAD.ts`):** the held-frame release now gates on
  vad-web's **positive** speech threshold (0.30) — the redemption counter resets only
  there, so releasing at the negative threshold (0.25) let gray-zone frames push the whole
  held queue (~1.3 s of near-silence) into the flush decode: Whisper's most reliable
  hallucination trigger, and the likeliest carrier of the field's suspected filler
  insertions. VAD thresholds/pads are now passed explicitly to `MicVAD.new` and the tap's
  constants derive from them. Held queue bounded (`HELD_MAX_FRAMES`, oldest streamed on
  overflow), so the "≤ 192 ms trailing silence" claim holds except under sustained
  borderline noise, where the bound is the cap.
- **Flush diagnostics (numbers only, C9.2):** the flush log line carries `tail_s`, worst
  per-segment `avg_logprob`/`no_speech_prob`, and `seam_suppressed` — the attribution data
  for the deferred v4.2 flush-tail veto decision (built only if filler insertions survive
  these fixes; any veto must withhold the whole tail, never edit words, per C5.5).

**Second round, same day — live long-form dictation findings (mid-sentence duplicates
persisted post-C7.12; senior-engineer re-review confirmed two tick-path defects):**

- **C7.13 (new) — tick-path frontier residue + boundary alignment.** Two parts:
  1. *Boundary alignment (correctness):* `agree()` now filters `prev` and `curr` at the
     SAME coordinate the caller's `localize()` used (`alignment_boundary_sample` =
     `plan.context_end_sample` = committed frontier **plus overflow**). Filtering at the
     stale `committed_through` while overflow > 0 left `prev` carrying words whose audio
     was dropped, so the prefix comparison compared different words and agreement returned
     **0 structurally** for as long as the overflow persisted — a stall latch whose only
     exit was the holdback ceiling force-committing and (silently, C5.6 `overrun`)
     discarding buffered audio. Field signature: decode windows pinned at 27 s,
     `tick_multiplier=4`, occupancy ≫ 1.
  2. *Residue guard:* `suppress_tick_residue()` (pure function) drops the leading `curr`
     word iff it `normalize_token`-equals the last committed word AND its **end** lies
     within `tick_residue_tolerance_s` (default 0.20 s; env
     `STREAM_TICK_RESIDUE_TOLERANCE_S`) of the frontier — at most one word per tick,
     applied before `prev` is read (restoring prefix alignment on the same tick) and
     inherited by the holdback force-commit path. END-gated, unlike C7.12's start gate:
     a tick residue is a properly-timed re-decode whose end drifted past the frontier; a
     genuine immediate repeat ends a full word-duration later. `prev` needs no guard — it
     is stored post-suppression. Counted as `tick_residue_suppressions` on the
     session-close line. The C7.2 20 ms tolerance stands for its original purpose; it was
     never adequate for shifted-window re-decodes under tick degradation, which is what
     the guard covers.
- **LocalAgreement premise (doc gap, now stated):** agreement assumes two independent
  decodes of overlapping audio converge on a stable prefix. faster-whisper's default
  temperature ladder (0.0…1.0 on fallback) *samples* past t=0, voiding that premise on
  exactly the windows that trip the fallback thresholds — `temperature` is therefore a
  **policy parameter**, not a quality knob. Bounding the ladder is a v4.2 tuning decision;
  recording the premise here is the v4.1 obligation.
- **Client wire-capture developer mode (no protocol change; recorded for the privacy
  posture):** `?debug=stream` URL param (deliberately not Settings/localStorage — a
  transcript-capturing diagnostic must not survive reloads), memory-only capped buffer of
  wire messages + client VAD markers, PCM as count/byte aggregates only, user-initiated
  Blob export as the sole exit path, cleared on session open and page unload. Server
  logging rules untouched. `docs/diagrams/privacy-data-flow.mmd` updated in the same
  commit.

**Amendments (2026-08-04, v4.1 sign-off review — word-join artifact found at review):**

- **C7.14 (new) — decoder-edge token merge.** faster-whisper marks word-initial tokens
  with a leading space and emits glued continuations (hyphenated suffixes, percent
  signs, digit groups) without one: `" K"`, `"-fold"`, `" 95"`, `"%"`. The streaming
  path previously stripped that signal (`localize()`) and re-joined committed words
  with plain spaces, fabricating `"K -fold"` / `"95 %"` — 9 artifact tokens per 412
  words in the 2026-08-04 live session, each scoring ≈ 1 substitution + 1 insertion
  against the space-preserving one-shot reference (contaminating `wer_micro` and
  `forced_span_wer`). Fix: `merge_glued_words()` (pure function, stream_policy) runs on
  the raw decoder tuples inside `_decode_sync` — before `localize()`, covering tick and
  flush paths at one site. A fragment starting with whitespace begins a new word;
  anything else concatenates onto the previous word (span = first start → last end,
  probability = min — conservative for the C7.4 floor); whitespace-only fragments drop.
  Consequences: a glued cluster is one `Word`, so a commit boundary can never split it
  — every downstream space-join (`committed_text`, flush assembly, wire, client-side
  delta join, bench tokenizer) is correct by construction, and no wire-contract change
  is needed (C4.x/C5.x untouched; the rejected alternative — carrying native spacing
  through `Word.text` — would have made C5.3 prefix checks fail whenever a commit
  boundary split a cluster). C7.11 interaction: flush-only languages whose tokens carry
  no leading spaces (ja/zh/th) merge to one `Word` per utterance — acceptable at flush,
  where no per-word vetoes apply and partials were already whole-utterance.
- **C8.2 amendment — teardown drain is bounded.** Releasing the single-session
  slot used to wait unbounded on the cancelled decode task
  (`await asyncio.gather(decode_task)`). Under starlette >= 1.x a client
  disconnect can leave that task parked in an await that never returns on the
  dead socket, so the slot was never released: the next session was refused
  `busy` until the process restarted — a browser tab closing mid-session was
  enough to wedge dictation. The drain is now bounded by `TEARDOWN_DRAIN_S`
  (2 s); on expiry the slot is released anyway, because a leaked slot is worse
  than an orphaned task that the event loop will collect. Found 2026-08-08 when
  the merge to `main` put the v4 line in front of CI for the first time and
  `test_disconnect_frees_slot_and_next_session_connects` failed against current
  dependencies — the test predates the bug and caught it exactly as intended.
- **C9.3 (new) — server-side per-tick hypothesis trace.** The sanctioned, opt-in-only
  server twin of the client wire-capture mode: `STREAM_TRACE_DIR` env var (empty
  default — no shipped launcher sets it; operator opt-in per process) writes one JSONL
  per session (`stream-trace-<session_id>.jsonl`) carrying per-tick hypothesis words,
  commit decisions, stall diagnostics (`agreed_n`/`eligible_n`/veto flags), holdback
  state, and flush records. **Content-bearing by design** — the header record says so;
  the file exists so `ops/scripts/policy_replay.py` can re-run the pure commit policy
  offline (`--verify` reproduces recorded decisions bit-exactly; `--set`/`--surface`
  run counterfactuals). C9.2's logging rules are untouched: transcript content never
  passes through structlog (the only enable-time log line carries the directory and
  session id), and the recommended target is a gitignored path. Companion close-line
  counters (always on, C9.2-safe): `stall_agreed_zero` / `stall_eligible_zero` /
  `stall_veto_edge` / `stall_veto_prob` — zero-commit ticks with a compared prev
  hypothesis, classified by cause; these decide which lever the v4.2 tuning pass
  actually has (hypothesis churn → holdback; edge stalls → edge guard).
- **C7.3 surface-form choice: MEASURED AND RETAINED (2026-08-05 replay evidence).**
  The candidate change — commit the *older* hypothesis's surface for agreed words, to
  recover sentence-final punctuation lost when a commit boundary lands on a sentence
  end — was evaluated offline against the pinned fixture (`policy_replay.py --surface
  prev --reference`, one-shot raws as ground truth): 18 surface-divergent commits;
  prev-correct 11, **prev-spurious 6**, neutral 1. Both hypotheses fabricate
  punctuation in both directions, and the same word commits *with* its period when
  the cut lands after the sentence boundary — the defect is cut-position-dependent,
  not hypothesis-choice-dependent. The pre-committed decision rule (adopt prev only
  on clear dominance with ~0 regressions) fails → **curr surface stands**. Parked for
  the v4.2 tuning pass with this evidence: punctuation-aware selection (prefer
  whichever surface carries sentence-final punctuation when the commit cut coincides
  with a sentence boundary), to be evaluated on the same replay harness before any
  code change.
