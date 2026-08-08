# v4 Field Test Runbook — live dictation through `stream_bench`

The field test closes the gate lines the 2026-07-31 gate run left open (roadmap, "Gate lines
not closed") and produces the varied-audio WER number the repeated fixture cannot. Without a
frontend, "live dictation" means: record real speech, replay it through `stream_bench` at
real-time pace with multiple flushes.

**Updated for the v4.1 re-spec (2026-08-01 field-test-review additions):** per-utterance
unchunked WER reference, `--split silence`, per-utterance latency percentiles, forced-span
WER, and the corrected gate lines below. Reports from before the re-spec
(`baseline_kind` absent) are not comparable on the WER or cost lines.

## 1. Prerequisites (one-time)

- **`websockets`** (the harness's only non-project dependency): already present
  in the project venv (`make venv`) as a `uvicorn[standard]` dependency;
  otherwise `pip install websockets`.
- **Bare-host GPU runs need `LD_LIBRARY_PATH`** pointed at the pip nvidia libs. Model *load*
  succeeds without it; the first *decode* fails with "Library libcublas.so.12 is not found".
  The Tauri sidecar sets this itself (`cuda_ld_library_path()`); Docker has the libs in the
  image; only manual `uvicorn` runs need it by hand:

  ```bash
  # Paths follow the project venv built by `make venv` (Python 3.12, the same
  # version the Docker image and CI run). `make venv` prints this line too.
  VENV=apps/api/.venv/lib/python3.12/site-packages/nvidia
  export LD_LIBRARY_PATH=$PWD/$VENV/cublas/lib:$PWD/$VENV/cuda_nvrtc/lib
  ```
- `ffmpeg` on PATH (the harness transcodes the recording client-side).

## 2. The recording

- **~3 minutes of real, varied dictation** (the v4-overall gate's session length). Vary
  sentence length and vocabulary; do not loop a fixture — repeated identical audio triggers
  Whisper temperature-fallback loops (2–5 s decodes) and collapses the one-shot baseline,
  making WER meaningless.
- Any format ffmpeg reads is fine (the harness converts to 16 kHz mono itself).
- With `--utterances 3`, a 3-minute recording yields ~60 s utterance segments — longer than
  `MAX_UNCOMMITTED_S` (24 s), which is exactly what the buffer-slide gate line needs.
- Keep the recording; if a number looks off after a tuning change, re-run the same audio.

## 3. Start the backend (bare-host, GPU)

```bash
cd apps/api
export LD_LIBRARY_PATH=...   # section 1
uvicorn app.main:app --port 8084
```

Wait for the model-load + warmup-decode log lines before benching (the load-time warmup
absorbs first-decode kernel setup).

## 4. Run — two gate runs, both required (v4.1)

```bash
# from the repo root, with the recording saved as e.g. ~/dictation.wav
# (a) VAD-representative run — the numbers v4.2 tunes against:
python ops/scripts/stream_bench.py ~/dictation.wav --utterances 20 --split silence \
    --baseline --report docs/v4/field-test-report-<date>-u20-silence.json
# (b) slide exerciser — the only run whose segments exceed MAX_UNCOMMITTED_S:
python ops/scripts/stream_bench.py ~/dictation.wav --utterances 3 --baseline \
    --report docs/v4/field-test-report-<date>-u3.json
```

- **Do not run single-flush gate runs** — the single-flush harness is what let the
  post-flush coordinate bug ship (peer review, 2026-07-31).
- `--split silence` places boundaries at centers of ≥ 300 ms silences nearest the even
  targets (parameters echoed into the report; loud fallback to even when too few qualify).
  Even splits at ≥ 20 utterances cut mid-phrase by construction — useful as a forced-span
  stressor, not VAD-representative.
- `--baseline` runs the **per-utterance unchunked reference**: each streamed utterance's own
  segment posted whole to `/transcribe` (> 60 s segments are `wer_excluded` — chunked only
  for the wall-clock cost line, never for WER; the retired whole-recording chunked reference
  is invalid — cuts land mid-phrase and chunk decodes hit temperature fallback). The **cost
  table is a required output of run (a)** — `baseline_kind` records the regime; walls under
  the new reference are **not comparable** to the 2026-08-01 chunked figure. A reference
  failure fails the gate via `baseline_completed`, never a silent exit 0.
- The report contains counters and latencies only — never transcript text.

## 5. Observations to record (the open gate lines)

While the run is live:

- **Zero persistence, observed:** `ls /tmp/voice-scribe/` (or `$TEMP_DIR`) during the run —
  must stay empty. (`stream_bench` itself briefly writes a *client-side* transcode temp in
  the system tmp dir and deletes it; the claim under test is the server path.)
- **Log sweep:** no transcript/hypothesis/audio content in any server log line.

After the run:

- **Gate block** printed by the harness (v4.1 lines): retractions 0, prefix invariant,
  utterance_alignment, dropped_audio_ms 0, force-commit rate < 5%,
  `first_partial_p50 ≤ 1.5 s` (anchor: `first_frame_sent` — the additive user-perceived
  number is a client measurement, protocol doc amendments),
  `finalization_max_excl_first ≤ 0.5 s` (excludes exactly the utterance-1 warm-up carry, a
  named v4.2 item; p50 and raw max reported), `partials_in_every_utterance`,
  `baseline_completed`, `divergence_not_boundary_concentrated` (near-boundary divergence
  rate ≤ 2× far-field; evaluated at ≥ 20 divergences), `forced_span_wer < 10%` (evaluated
  only at ≥ 20 forced words). `wer_micro` is **reported, never gated** — re-specified on
  its first run (2026-08-01, evidence in the roadmap gate list): the aggregate measures
  independent decode-regime divergence (~10–15% expected), not commit-policy damage.
- **Divergence buckets** (`wer.divergence_buckets`): exposure-normalized divergence rates by
  distance to the nearest commit boundary. Boundary-concentrated divergence = commit-policy
  defect (blocks); boundary-independent = independent mishearings (the failure protocol in
  the roadmap gate list).
- **`stream session closed` server log line:** `ticks_skipped / ticks ≤ 1%`,
  `tick_multiplier == 1`, `occupancy_p95 ≤ 0.7` (+ `occupancy_max`, `decode_seconds_total`
  for the cost table) — these are **server-internal, read from this log line only**;
  `stream_bench` never carries them (the server gains no instrumentation hooks).
- **`nvidia-smi` + `ps` after close:** VRAM back to the idle model footprint, no stray
  processes.
- **Cost table** from the report: `decode_seconds_total` (server log) per audio-second vs
  `baseline.oneshot_wall_s`; decode premium stated as "X× bought Y ms" against the 3–5×
  envelope. State `baseline_kind` next to the number.
- **WER:** `wer_micro` + per-utterance list. Also read both transcripts yourself — WER is
  blind to "wrong but plausible" substitutions in committed text.

Latency numbers from this run supersede the 2026-07-31 numbers (the tick-pacing fix changed
the cadence; the old numbers were measured on the slower loop). Record results in the
roadmap's v4.0 status block, same voice as the existing entries: met / missed with named
cause / deferred with reason.

## 6. What "watch the dictation" means for the three-minute session

While the transcript scrolls in the report’s message flow (or when v4.1 renders it live):

- Committed text must never visibly change — any edit to already-committed words is a
  retraction even if the reducer misses it.
- The partial tail may flicker; it must never survive *incorrectly* into committed text.
- A word committed at an utterance boundary must not reappear at the start of the next
  utterance (the duplicate-commit regression).
- Note anything the numbers don't capture: odd punctuation at commit boundaries, first-word
  truncation, hallucinated words during pauses.

## 7. Interactive real-mic smoke runbook (v4.1 sign-off sitting)

Added 2026-08-02 (PM review flag: the smoke previously existed only as roadmap prose).
One sitting closes every remaining human-in-the-loop gate line. **Open the record with a
configuration line** — browser + version, model, device, server mode, commit — like every
other run in the v4 record.

Preconditions: backend bare-host GPU server (section 3) on the post-`3666c4f` code,
`make web` (or `make desktop` for the WebKitGTK pass), microphone.

1. **Three-minute continuous dictation** (Settings → continuous mode). Watch per section 6.
   Additionally count, against your own speech: flush-boundary duplicates (expected ~0
   after the C7.12 fix; any occurrence → note whether `seam_suppressed=True` appears on
   the server's flush line for that utterance), suspected filler insertions at pauses
   (finding (c)), substitutions (finding (b)).
2. **Fresh gate recording:** save one ~3–4 min dictation WAV (outside the repo), then run
   the section-4 pair (u20-silence + u3) against it and record the HR-8 delta table
   (HR-8 = the hard-requirement key-metric deltas — latency, force rate, WER lines,
   seam counters — vs the 2026-08-01 report JSONs; the ID came from the
   2026-08-02 review numbering and is defined here so the runbook stands alone). The seam counters (`seam_dup_intra_final`,
   `seam_dup_inter_final`, `seam_eligible_flushes`) must be in the committed report.
3. **Kill-server fallback:** mid-utterance, `kill` the uvicorn process → the frontend must
   fall back to the one-shot path, replaying the retained utterance PCM; no committed text
   lost, error surfaced non-fatally.
4. **Post-close hygiene:** after stopping, `ps` for orphaned processes and `nvidia-smi`
   for residual VRAM (gate line: clean after session close).
5. **Transcript-vs-spoken comparison** for findings (b)/(c) on two utterances of the
   recording. **Privacy rule:** the committed artifact carries counts, rates, and
   positions relative to flush boundaries only — never transcript text, never audio.
   Short illustrative word pairs are the ceiling (Engineering Rules; PM flag 3).
6. **VAD detection lag** via `apps/web/spike/vad-frames.html` (mic or speech-file run) —
   reported next to the server-side finalization number per the protocol's first-partial
   anchor record.
7. **WebKitGTK adapter check:** repeat a short version of step 1 under `make desktop`;
   ScriptProcessor is the in-library contingency if the AudioWorklet path fails.

Record outcomes in the roadmap v4.1 block (met / missed with named cause / deferred with
reason), then convene the three-persona sign-off review.
