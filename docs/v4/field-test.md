# v4.0 Field Test Runbook — live dictation through `stream_bench`

The field test closes the gate lines the 2026-07-31 gate run left open (roadmap, "Gate lines
not closed") and produces the varied-audio WER number the repeated fixture cannot. v4.1 has
no frontend yet, so "live dictation" means: record real speech, replay it through
`stream_bench` at real-time pace with multiple flushes.

## 1. Prerequisites (one-time)

- **`websockets`** (the harness's only non-project dependency):
  `pip install websockets`
- **Bare-host GPU runs need `LD_LIBRARY_PATH`** pointed at the pip nvidia libs. Model *load*
  succeeds without it; the first *decode* fails with "Library libcublas.so.12 is not found".
  The Tauri sidecar sets this itself (`cuda_ld_library_path()`); Docker has the libs in the
  image; only manual `uvicorn` runs need it by hand:

  ```bash
  export LD_LIBRARY_PATH=$HOME/.local/lib/python3.11/site-packages/nvidia/cublas/lib:$HOME/.local/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib
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

## 4. Run

```bash
# from the repo root, with the recording saved as e.g. ~/dictation.wav
python ops/scripts/stream_bench.py ~/dictation.wav --utterances 3 --baseline \
    --report /tmp/field_test_report.json
```

- `--utterances 3` splits the audio into 3 segments with a flush after each. **Do not run
  single-flush gate runs** — the single-flush harness is what let the post-flush coordinate
  bug ship (peer review, 2026-07-31).
- `--baseline` runs the same audio through the one-shot path and reports
  `committed_vs_oneshot_wer` plus GPU duty cycle / peak VRAM for the cost table.
- The report contains counters and latencies only — never transcript text.

## 5. Observations to record (the open gate lines)

While the run is live:

- **Zero persistence, observed:** `ls /tmp/voice-scribe/` (or `$TEMP_DIR`) during the run —
  must stay empty. (`stream_bench` itself briefly writes a *client-side* transcode temp in
  the system tmp dir and deletes it; the claim under test is the server path.)
- **Log sweep:** no transcript/hypothesis/audio content in any server log line.

After the run:

- **Gate block** printed by the harness: retractions 0, prefix invariant, dropped_audio_ms 0,
  force-commit rate < 5%, first partial ≤ 1.5 s, finalization ≤ 0.5 s (now the **max across
  flushes**), `partials_in_every_utterance` PASS (the multi-utterance regression line).
- **`stream session closed` server log line:** `ticks_skipped` (gate: 0 on this nominal run)
  and `occupancy_p95` (gate: ≤ 0.7) — these are server-internal and reported only here.
- **`nvidia-smi` + `ps` after close:** VRAM back to the idle model footprint, no stray
  processes.
- **Cost table** from the report: `gpu_during_stream` vs `gpu_during_oneshot` duty cycle and
  peak VRAM; decode premium stated as "X× bought Y ms" against the 3–5× envelope.
- **WER:** `committed_vs_oneshot_wer` < 3%. Also read both transcripts yourself — WER is
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
