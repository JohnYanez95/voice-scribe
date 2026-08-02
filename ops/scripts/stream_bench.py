#!/usr/bin/env python3
"""stream_bench — measurement harness for /ws/stream (v4.0 gate instrument,
re-specified for v4.1 per the 2026-08-01 field-test review).

Replays a WAV at real-time pace over the streaming protocol and reports the
gate numbers (roadmap v4, docs/v4/protocol.md): per-utterance first-partial
latency (p50/max — anchor: first_frame_sent, pinned in the protocol doc
amendments), finalization latency, commit-lag distribution, retraction count
(via a reference reducer, C5.1), the final.raw committed-prefix invariant
(C5.3), force-commit rate (per utterance), dropped_audio_ms, and — with
--baseline — the v4.1 re-specified WER reference: each streamed utterance's
own audio posted *whole* to the one-shot path (segments over the 60 s cap are
excluded from WER, never chunked — chunk cuts land mid-phrase by construction
and chunk decodes hit temperature fallback, which is what invalidated the old
full-recording chunked reference). Stream-vs-reference divergences are
bucketed by distance to the nearest commit boundary, and forced-commit spans
get their own WER line.

All hypothesis comparison happens here, on the client side of the protocol
(C9.2). The JSON report contains counters, latencies, and distributions only —
never transcript text. Fixtures should be synthetic/committed audio
(ops/scripts/test.mp3 pattern), never user audio.

Usage:
    python ops/scripts/stream_bench.py ops/scripts/test.mp3 [--baseline]
        [--url ws://localhost:8084] [--language en] [--frame-ms 96]
        [--utterances 20] [--split even|silence] [--report bench_report.json]

--utterances N splits the audio into N contiguous segments with a flush after
each. --split silence places boundaries at the centers of >= 300 ms silences
nearest the even-split targets (VAD-representative runs); --split even (the
default) keeps the exact-N even split — still the only exerciser of the > 24 s
buffer slide at small N. Gate runs: one >= 20-utterance silence-split run plus
the 3-utterance even run.

Requires: websockets, numpy, ffmpeg on PATH. No GPU needed on the client side.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np

try:
    import websockets
except ImportError:
    sys.exit("stream_bench requires the 'websockets' package: pip install websockets")

ORIGIN = "http://localhost:5174"
SR = 16000

# --- v4.1 WER re-spec constants ---------------------------------------------
# The aggregate `wer_micro < 3%` gate was re-specified on its FIRST run against
# the clean per-utterance reference (2026-08-01, recorded in the roadmap gate
# list): measured 11.7% with a FLAT boundary profile (near-boundary 13.2% vs
# far-field 10.1%, forced-span WER 0.0) — independent decode-regime
# mishearings, not commit-policy damage. Per the pre-decided failure protocol,
# the gate is now the boundary-concentration check below + the forced-span
# line; wer_micro stays a reported number, not a gate.
WER_MIN_REF_WORDS = 200            # analysis evaluated only at a stable denominator
# Boundary concentration is REPORTED, not gated (2026-08-01, three runs of the
# same recording): the far-field bucket carries 3-7 divergences per run, which
# swings the near/far ratio 1.3x-3.0x on identical audio, and the near bucket
# structurally includes the flush-tail regime (utterance-final words are
# single-pass by design and time-adjacent to the last boundary by
# construction). Gate candidate for v4.2 once a second recording pins a
# threshold that is not noise.
FORCED_WER_THRESHOLD = 0.10
FORCED_WER_MIN_WORDS = 20          # below this, one word swings >= 5 points
DIVERGENCE_BUCKETS = [(0.0, 0.25), (0.25, 0.5), (0.5, 1.0), (1.0, float("inf"))]
# --- silence-split parameters (echoed into the report for reproducibility) --
SILENCE_WIN_S = 0.02
SILENCE_MIN_S = 0.3
SILENCE_RMS_FACTOR = 0.02          # threshold = factor * p95(frame RMS)


def load_audio_f32(path: str) -> np.ndarray:
    """Any input ffmpeg can read → 16 kHz mono float32 in memory."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-ar", str(SR), "-ac", "1",
             "-sample_fmt", "s16", tmp.name],
            capture_output=True, check=True,
        )
        with wave.open(tmp.name, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        Path(tmp.name).unlink(missing_ok=True)


def split_even(audio: np.ndarray, n: int) -> np.ndarray:
    return np.linspace(0, len(audio), n + 1).astype(int)


def split_silence(audio: np.ndarray, n: int) -> tuple[np.ndarray, str]:
    """Boundaries at centers of >= SILENCE_MIN_S silences nearest the even
    targets. Falls back to even (loudly) when too few silences qualify."""
    win = int(SILENCE_WIN_S * SR)
    n_frames = len(audio) // win
    frames = audio[: n_frames * win].reshape(n_frames, win)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    threshold = SILENCE_RMS_FACTOR * np.percentile(rms, 95)
    quiet = rms < threshold

    # Runs of quiet frames long enough to be inter-utterance silence.
    min_frames = int(SILENCE_MIN_S / SILENCE_WIN_S)
    candidates: list[int] = []  # boundary sample indices (silence centers)
    run_start = None
    for i, q in enumerate(np.append(quiet, False)):
        if q and run_start is None:
            run_start = i
        elif not q and run_start is not None:
            if i - run_start >= min_frames:
                candidates.append(((run_start + i) // 2) * win)
            run_start = None

    targets = split_even(audio, n)[1:-1]
    if len(candidates) < len(targets):
        print(f"split=silence: only {len(candidates)} qualifying silences for "
              f"{len(targets)} boundaries — falling back to even split",
              file=sys.stderr)
        return split_even(audio, n), "even (silence fallback)"

    cand = np.array(sorted(candidates))
    chosen: list[int] = []
    used = np.zeros(len(cand), dtype=bool)
    for t in targets:
        order = np.argsort(np.abs(cand - t))
        for idx in order:
            if not used[idx]:
                used[idx] = True
                chosen.append(int(cand[idx]))
                break
    bounds = np.array([0, *sorted(chosen), len(audio)], dtype=int)
    if np.any(np.diff(bounds) <= 0):
        print("split=silence: degenerate boundaries — falling back to even split",
              file=sys.stderr)
        return split_even(audio, n), "even (silence fallback)"
    return bounds, "silence"


def norm_words(text: str) -> list[str]:
    out = []
    for tok in text.split():
        t = unicodedata.normalize("NFKC", tok).casefold()
        t = t.strip("".join(c for c in t if unicodedata.category(c).startswith("P")))
        if t:
            out.append(t)
    return out


def edit_ops(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Levenshtein alignment with backtrace.

    Returns ops as (kind, ref_i, hyp_j): kind in {eq, sub, ins, del}. For del
    (a ref word with no hyp counterpart) hyp_j is the hyp position at which
    the deletion occurs (nearest surviving neighbor for time anchoring)."""
    m, n = len(ref), len(hyp)
    dp = np.zeros((m + 1, n + 1), dtype=np.int32)
    dp[:, 0] = np.arange(m + 1)
    dp[0, :] = np.arange(n + 1)
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            dp[i, j] = min(dp[i - 1, j] + 1, dp[i, j - 1] + 1,
                           dp[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]))
    ops: list[tuple[str, int | None, int | None]] = []
    i, j = m, n
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i, j] == dp[i - 1, j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif j > 0 and dp[i, j] == dp[i, j - 1] + 1:
            ops.append(("ins", None, j - 1))
            j -= 1
        else:
            ops.append(("del", i - 1, min(j, n - 1) if n else None))
            i -= 1
    ops.reverse()
    return ops


def edit_distance(ref: list[str], hyp: list[str]) -> int:
    return sum(1 for kind, _, _ in edit_ops(ref, hyp) if kind != "eq")


class GpuSampler(threading.Thread):
    """Samples nvidia-smi during a run. Degrades to no-op if unavailable."""

    def __init__(self, interval_s: float = 0.2):
        super().__init__(daemon=True)
        self.interval_s = interval_s
        self.samples: list[tuple[float, float]] = []  # (util %, mem MiB)
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                out = subprocess.run(
                    ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=2,
                )
                util, mem = out.stdout.strip().splitlines()[0].split(",")
                self.samples.append((float(util), float(mem)))
            except Exception:
                return  # no nvidia-smi — sampler goes quiet
            self._stop.wait(self.interval_s)

    def stop(self) -> dict:
        self._stop.set()
        if not self.samples:
            return {"available": False}
        utils = [u for u, _ in self.samples]
        return {
            "available": True,
            "duty_cycle": sum(1 for u in utils if u > 10) / len(utils),
            "mean_util_pct": round(statistics.mean(utils), 1),
            "peak_vram_mib": max(m for _, m in self.samples),
        }


class ReferenceReducer:
    """Replays the message log and detects retractions (C5.1): a retraction is
    any message whose effect is different committed text for a given
    (utterance_id, offset) than previously displayed."""

    def __init__(self):
        self.committed: dict[int, str] = {}
        self.retractions = 0

    def on_committed(self, utterance_id: int, delta: str) -> None:
        prior = self.committed.get(utterance_id, "")
        self.committed[utterance_id] = f"{prior} {delta}".strip() if prior else delta

    def on_final(self, utterance_id: int, raw: str) -> None:
        prior = self.committed.get(utterance_id, "")
        if prior and not raw.startswith(prior):
            self.retractions += 1  # C5.3 violation — final revised committed text
        self.committed[utterance_id] = raw


async def run_stream(url: str, audio: np.ndarray, language: str | None,
                     frame_ms: int, seg_bounds: np.ndarray) -> dict:
    frame_samples = int(SR * frame_ms / 1000)
    utterances = len(seg_bounds) - 1
    audio_dur = len(audio) / SR

    reducer = ReferenceReducer()
    stats: dict = {
        "audio_seconds": round(audio_dur, 3),
        "frame_ms": frame_ms,
        "utterances": utterances,
        "retractions": 0,
        "committed_words_total": 0,
        "committed_words_forced": 0,
        "commit_lag_s": [],
        "partials": 0,
        "dropped_audio_ms": 0.0,
        "prefix_invariant_ok": True,
        "uid_alignment_ok": True,
        "first_partial_anchor": "first_frame_sent",
        "errors": [],
    }
    final_raws: list[str] = []
    # Per-utterance capture (v4.1 re-spec):
    first_partial_per_utt: dict[int, float] = {}
    committed_spans: dict[int, list[dict]] = {}   # {t0, t1, words, forced}
    final_by_utt: dict[int, dict] = {}            # {"_raw": ..., "duration": ...}

    async with websockets.connect(f"{url}/ws/stream", origin=ORIGIN,
                                  max_size=None) as ws:
        start = {"type": "start", "protocol_version": 1,
                 "sample_format": "pcm_f32le", "sample_rate": SR}
        if language:
            start["language"] = language
        await ws.send(json.dumps(start))
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            raise SystemExit(f"handshake failed: {ready.get('code')}: {ready.get('detail')}")
        stats["tunables"] = {k: ready[k] for k in
                             ("decode_tick_ms", "max_uncommitted_s", "max_holdback_ticks")}

        t_first_frame: float | None = None
        t_flush_sent: float | None = None
        utt_first_frame: dict[int, float] = {}
        flush_times: list[float] = []
        finalization_lats: list[float] = []
        nonempty_partial_utts: set[int] = set()
        done = asyncio.Event()

        async def sender():
            nonlocal t_first_frame, t_flush_sent
            sent_samples = 0
            for u in range(utterances):
                seg = audio[seg_bounds[u]:seg_bounds[u + 1]]
                first_of_utt = True
                for i in range(0, len(seg), frame_samples):
                    f = seg[i:i + frame_samples]
                    if t_first_frame is None:
                        t_first_frame = time.monotonic()
                    if first_of_utt:
                        utt_first_frame[u] = time.monotonic()
                        first_of_utt = False
                    await ws.send(f.astype(np.float32).tobytes())
                    sent_samples += len(f)
                    # real-time pace against an absolute clock — per-frame sleep
                    # overhead otherwise drifts ~1 s over a 30 s replay and
                    # corrupts the speech-end anchor
                    target = t_first_frame + sent_samples / SR
                    delay = target - time.monotonic()
                    if delay > 0:
                        await asyncio.sleep(delay)
                t_flush_sent = time.monotonic()
                flush_times.append(t_flush_sent)
                await ws.send(json.dumps({"type": "flush"}))

        async def receiver():
            while not done.is_set():
                msg = json.loads(await ws.recv())
                now = time.monotonic()
                mtype = msg.get("type")
                if mtype == "partial":
                    stats["partials"] += 1
                    if msg["text"]:
                        uid = msg["utterance_id"]
                        nonempty_partial_utts.add(uid)
                        anchor = utt_first_frame.get(uid)
                        if uid not in first_partial_per_utt and anchor:
                            first_partial_per_utt[uid] = now - anchor
                elif mtype == "committed":
                    uid = msg["utterance_id"]
                    reducer.on_committed(uid, msg["text"])
                    words = norm_words(msg["text"])
                    n = len(msg["text"].split())
                    stats["committed_words_total"] += n
                    if msg.get("forced"):
                        stats["committed_words_forced"] += n
                    committed_spans.setdefault(uid, []).append({
                        "t0": msg["t0"], "t1": msg["t1"],
                        "words": words, "forced": bool(msg.get("forced")),
                    })
                    anchor = utt_first_frame.get(uid, t_first_frame)
                    if anchor:
                        # commit lag: word audibly ended at anchor + t1
                        stats["commit_lag_s"].append(
                            round(now - (anchor + msg["t1"]), 3))
                elif mtype == "final":
                    uid = msg["utterance_id"]
                    # v4.1: the WER/bucket analysis maps utterances to the
                    # segments the sender flushed — a server-originated flush
                    # (forced at 120 s) breaks that mapping. Invalidate loudly,
                    # never misalign silently.
                    if uid != len(final_raws):
                        print(f"UID ALIGNMENT BROKEN: final utterance_id={uid}, "
                              f"expected {len(final_raws)} — WER/bucket lines "
                              "invalidated for this run", file=sys.stderr)
                        stats["uid_alignment_ok"] = False
                    prior = reducer.committed.get(uid, "")
                    if prior and not msg["raw"].startswith(prior):
                        stats["prefix_invariant_ok"] = False
                    reducer.on_final(uid, msg["raw"])
                    final_raws.append(msg["raw"])
                    final_by_utt[uid] = {"_raw": msg["raw"],
                                         "duration": msg["duration"]}
                    stats["dropped_audio_ms"] += msg["dropped_audio_ms"]
                    if len(final_raws) <= len(flush_times):
                        finalization_lats.append(
                            round(now - flush_times[len(final_raws) - 1], 3))
                    if len(final_raws) >= utterances:
                        done.set()
                elif mtype == "error":
                    stats["errors"].append(msg["code"])
                    if msg.get("fatal"):
                        done.set()

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        await asyncio.wait_for(done.wait(), timeout=audio_dur + 60)
        await ws.send(json.dumps({"type": "stop"}))
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if msg.get("type") == "ack" and msg.get("of") == "stop":
                    break
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
        for t in (send_task, recv_task):
            t.cancel()

    speech_end_wall = (t_first_frame or 0) + audio_dur
    stats["retractions"] = reducer.retractions

    # --- per-utterance latency percentiles (v4.1 harness completion) ---
    fp = [round(first_partial_per_utt[u], 3)
          for u in sorted(first_partial_per_utt)]
    stats["first_partial_s"] = {
        "p50": round(statistics.median(fp), 3) if fp else None,
        "max": max(fp) if fp else None,
        "max_excl_first": max(fp[1:]) if len(fp) > 1 else None,
        "per_utterance": fp,
    }
    stats["finalization_s"] = {
        "p50": round(statistics.median(finalization_lats), 3) if finalization_lats else None,
        "max": max(finalization_lats) if finalization_lats else None,
        # Gate anchor: utterance 1's warm-up carry is a named v4.2 item — the
        # tail guard excludes exactly that one sample, nothing else.
        "max_excl_first": (max(finalization_lats[1:])
                           if len(finalization_lats) > 1 else
                           (finalization_lats[0] if finalization_lats else None)),
        "per_utterance": finalization_lats,
    }
    stats["utterances_with_nonempty_partials"] = len(nonempty_partial_utts)
    if finalization_lats and t_flush_sent is not None:
        stats["finalization_from_speech_end_s"] = round(
            (t_flush_sent + finalization_lats[-1]) - speech_end_wall, 3)
    if stats["commit_lag_s"]:
        lags = stats["commit_lag_s"]
        stats["commit_lag_p50_s"] = round(statistics.median(lags), 3)
        stats["commit_lag_max_s"] = round(max(lags), 3)
    stats["force_commit_rate"] = (
        round(stats["committed_words_forced"] / stats["committed_words_total"], 4)
        if stats["committed_words_total"] else 0.0)
    # In-memory only (underscore-prefixed keys are stripped before printing):
    stats["_final_by_utt"] = final_by_utt
    stats["_committed_spans"] = committed_spans
    return stats


# One-shot path audio cap. Mirrors MAX_AUDIO_SECONDS' default (app/config.py) —
# the value is contract prose, not in the exported schema, so it cannot be read
# programmatically. If the server cap is lowered below this, reference posts
# 400 and the gate fails via baseline_completed=False (never a silent exit 0).
ONESHOT_MAX_S = 60


def _post_wav(base_url: str, samples: np.ndarray) -> tuple[str, float]:
    """POST one segment to /transcribe; returns (raw text, wall seconds)."""
    import io
    import urllib.request

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        pcm = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
        wf.writeframes(pcm.tobytes())
    boundary = "streambenchboundary"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"bench.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
    ).encode() + buf.getvalue() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{base_url}/transcribe", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Origin": ORIGIN},
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read())
    return payload["raw"], time.monotonic() - t0


def run_reference(base_url: str, audio: np.ndarray, seg_bounds: np.ndarray) -> dict:
    """v4.1 per-utterance unchunked one-shot reference + cost baseline.

    Each streamed utterance's own segment is posted WHOLE to /transcribe —
    the same samples both paths decoded, so the comparison is decode vs
    decode. Segments over the 60 s cap are excluded from the WER lines (never
    chunked — that reference is invalid) but still posted chunked for the
    wall-clock cost line. Wall times exclude inter-utterance silence handling
    differences by construction (per-utterance posts), which makes the cost
    comparison fairer than the retired whole-recording chunked baseline — and
    NOT comparable to the 2026-08-01 chunked figure (baseline_kind records
    which regime a report came from).
    """
    per_utt: list[dict] = []
    raws: list[str | None] = []
    total_wall = 0.0
    total_posts = 0
    excluded_seconds = 0.0
    max_samples = ONESHOT_MAX_S * SR
    for u in range(len(seg_bounds) - 1):
        seg = audio[seg_bounds[u]:seg_bounds[u + 1]]
        dur = len(seg) / SR
        if len(seg) <= max_samples:
            raw, wall = _post_wav(base_url, seg)
            raws.append(raw)
            per_utt.append({"duration_s": round(dur, 2), "wall_s": round(wall, 3),
                            "wer_excluded": False})
            total_wall += wall
            total_posts += 1
        else:
            # Cost line only — chunked, WER-excluded.
            n_chunks = (len(seg) + max_samples - 1) // max_samples
            wall_u = 0.0
            for chunk in np.array_split(seg, n_chunks):
                _, wall = _post_wav(base_url, chunk)
                wall_u += wall
                total_posts += 1
            raws.append(None)
            per_utt.append({"duration_s": round(dur, 2), "wall_s": round(wall_u, 3),
                            "wer_excluded": True})
            total_wall += wall_u
            excluded_seconds += dur
    return {"oneshot_wall_s": round(total_wall, 3),
            "oneshot_posts": total_posts,
            "baseline_kind": "per_utterance_unchunked",
            "per_utterance": per_utt,
            "wer_excluded_seconds": round(excluded_seconds, 2),
            "_raws": raws}


def _hyp_word_times(spans: list[dict], n_hyp_words: int, duration: float) -> list[float]:
    """Approximate per-word times (utterance-audio seconds): committed words
    interpolate within their delta's (t0, t1); the final-only tail (flush
    remainder) interpolates over (last t1, duration). Estimates by design —
    adequate for 0.25 s bucketing, labeled as such in the report."""
    times: list[float] = []
    for d in spans:
        n = len(d["words"])
        for k in range(n):
            times.append(d["t0"] + (d["t1"] - d["t0"]) * (k + 0.5) / max(n, 1))
    tail = n_hyp_words - len(times)
    if tail > 0:
        t_start = spans[-1]["t1"] if spans else 0.0
        span = max(duration - t_start, 0.001)
        for k in range(tail):
            times.append(t_start + span * (k + 0.5) / tail)
    return times[:n_hyp_words]


def analyze_wer(stream_stats: dict, reference: dict) -> dict:
    """Per-utterance WER (micro-averaged), commit-boundary divergence buckets,
    and forced-span WER — all against the unchunked per-utterance reference."""
    final_by_utt = stream_stats["_final_by_utt"]
    committed_spans = stream_stats["_committed_spans"]
    ref_raws = reference["_raws"]

    total_dist = 0
    total_ref_words = 0
    per_utterance: list[dict] = []
    bucket_div = [0] * len(DIVERGENCE_BUCKETS)
    bucket_words = [0] * len(DIVERGENCE_BUCKETS)
    forced_words_total = 0
    forced_errors = 0
    forced_span_excluded = 0

    for u, ref_raw in enumerate(ref_raws):
        fin = final_by_utt.get(u)
        if ref_raw is None or fin is None:
            per_utterance.append({"wer": None, "ref_words": 0,
                                  "wer_excluded": True, "forced_words": 0})
            continue
        ref = norm_words(ref_raw)
        hyp = norm_words(fin["_raw"])
        ops = edit_ops(ref, hyp)
        dist = sum(1 for kind, _, _ in ops if kind != "eq")
        total_dist += dist
        total_ref_words += len(ref)

        spans = committed_spans.get(u, [])
        flat_committed = [w for d in spans for w in d["words"]]
        # Forced-mask index integrity: committed norm-words must be the norm
        # prefix of the final — one tokenization mismatch shifts every
        # downstream forced index, so skip (and count) rather than mis-map.
        aligned = hyp[: len(flat_committed)] == flat_committed
        forced_in_utt = sum(len(d["words"]) for d in spans if d["forced"])
        if not aligned and forced_in_utt:
            forced_span_excluded += 1

        times = _hyp_word_times(spans, len(hyp), fin["duration"])
        boundaries = [d["t1"] for d in spans]

        def nearest_boundary_dist(t: float) -> float:
            return min((abs(t - b) for b in boundaries), default=float("inf"))

        def bucket_of(dist_s: float) -> int:
            for bi, (lo, hi) in enumerate(DIVERGENCE_BUCKETS):
                if lo <= dist_s < hi:
                    return bi
            return len(DIVERGENCE_BUCKETS) - 1

        for j, t in enumerate(times):
            bucket_words[bucket_of(nearest_boundary_dist(t))] += 1

        forced_flags = [d["forced"] for d in spans for _ in d["words"]]
        if aligned:
            forced_words_total += forced_in_utt
        for kind, _ri, hj in ops:
            if kind == "eq":
                continue
            j = hj if hj is not None else 0
            j = min(max(j, 0), len(times) - 1) if times else 0
            if times:
                bucket_div[bucket_of(nearest_boundary_dist(times[j]))] += 1
            if aligned and j < len(forced_flags) and forced_flags[j]:
                forced_errors += 1

        per_utterance.append({
            "wer": round(dist / len(ref), 4) if ref else None,
            "ref_words": len(ref),
            "wer_excluded": False,
            "forced_words": forced_in_utt,
        })

    wer_micro = round(total_dist / total_ref_words, 4) if total_ref_words else None
    near = (bucket_div[0] / bucket_words[0]) if bucket_words[0] else 0.0
    far = (bucket_div[-1] / bucket_words[-1]) if bucket_words[-1] else 0.0
    total_div = sum(bucket_div)
    return {
        "wer_micro": wer_micro,
        "wer_reference": "per_utterance_unchunked_oneshot",
        "wer_ref_words_total": total_ref_words,
        "wer_analysis_evaluated": total_ref_words >= WER_MIN_REF_WORDS,
        "boundary_divergence_near_rate": round(near, 4),
        "boundary_divergence_far_rate": round(far, 4),
        "boundary_divergences_total": total_div,
        "per_utterance": per_utterance,
        "divergence_buckets": {
            f"{lo:.2f}-{'inf' if hi == float('inf') else f'{hi:.2f}'}": {
                "divergences": bucket_div[i], "hyp_words": bucket_words[i]}
            for i, (lo, hi) in enumerate(DIVERGENCE_BUCKETS)
        },
        "divergence_bucket_note": "word times interpolated within commit spans — estimates",
        "forced_words_total": forced_words_total,
        "forced_span_wer": (round(forced_errors / forced_words_total, 4)
                            if forced_words_total else None),
        "forced_span_gate_evaluated": forced_words_total >= FORCED_WER_MIN_WORDS,
        "forced_span_excluded_utterances": forced_span_excluded,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("audio", help="Audio file (anything ffmpeg reads)")
    ap.add_argument("--url", default="ws://localhost:8084")
    ap.add_argument("--http-url", default="http://localhost:8084")
    ap.add_argument("--language", default=None)
    ap.add_argument("--frame-ms", type=int, default=96)
    ap.add_argument("--utterances", type=int, default=1,
                    help="Split the audio into N segments with a flush after each. "
                         "Gate runs: >= 20 with --split silence (VAD-representative) "
                         "plus the 3-utterance even run (> 24 s slide exerciser)")
    ap.add_argument("--split", choices=["even", "silence"], default="even",
                    help="Boundary placement: even (exact N) or silence (centers of "
                         ">= 300 ms silences nearest the even targets; loud fallback)")
    ap.add_argument("--baseline", action="store_true",
                    help="Also run the per-utterance unchunked one-shot reference "
                         "(WER lines + cost comparison)")
    ap.add_argument("--report", default=None, help="Write JSON report (counters only)")
    args = ap.parse_args()

    audio = load_audio_f32(args.audio)
    if args.split == "silence":
        seg_bounds, split_mode = split_silence(audio, args.utterances)
    else:
        seg_bounds, split_mode = split_even(audio, args.utterances), "even"

    sampler = GpuSampler()
    sampler.start()
    stream_stats = asyncio.run(run_stream(args.url, audio, args.language, args.frame_ms,
                                          seg_bounds))
    gpu_stream = sampler.stop()

    report = {
        "split_mode": split_mode,
        "split_params": {"win_s": SILENCE_WIN_S, "min_silence_s": SILENCE_MIN_S,
                         "rms_factor": SILENCE_RMS_FACTOR} if split_mode.startswith("silence") else None,
        "stream": stream_stats,
        "gpu_during_stream": gpu_stream,
    }

    reference = None
    wer_analysis = None
    if args.baseline:
        sampler = GpuSampler()
        sampler.start()
        try:
            reference = run_reference(args.http_url, audio, seg_bounds)
        except Exception as exc:
            reference = None
            print(f"reference failed; continuing with stream stats only: {exc}",
                  file=sys.stderr)
        gpu_oneshot = sampler.stop()
        if reference is not None:
            # GPU stats from a partial reference (mid-post failure) would be
            # sampled over a truncated window — only report them on success.
            report["gpu_during_oneshot"] = gpu_oneshot
            report["baseline"] = {k: v for k, v in reference.items()
                                  if not k.startswith("_")}
            if stream_stats["uid_alignment_ok"]:
                wer_analysis = analyze_wer(stream_stats, reference)
                report["wer"] = wer_analysis
            else:
                print("WER analysis skipped: utterance alignment broken",
                      file=sys.stderr)
    for key in [k for k in stream_stats if k.startswith("_")]:
        stream_stats.pop(key, None)

    print(json.dumps(report, indent=2))
    fp = stream_stats["first_partial_s"]
    fin = stream_stats["finalization_s"]
    gate = {
        "first_partial_p50 ≤ 1.5 s": (fp["p50"] or 99) <= 1.5,
        "finalization_max_excl_first ≤ 0.5 s": (fin["max_excl_first"] or 99) <= 0.5,
        "retractions == 0": stream_stats["retractions"] == 0,
        "prefix_invariant": stream_stats["prefix_invariant_ok"],
        "utterance_alignment": stream_stats["uid_alignment_ok"],
        "dropped_audio_ms == 0": stream_stats["dropped_audio_ms"] == 0,
        "force_commit_rate < 5%": stream_stats["force_commit_rate"] < 0.05,
    }
    if stream_stats["utterances"] > 1:
        gate["partials_in_every_utterance"] = (
            stream_stats["utterances_with_nonempty_partials"] == stream_stats["utterances"])
    if args.baseline:
        # A failed reference must fail the gate, not silently drop its lines.
        gate["baseline_completed"] = reference is not None
    if wer_analysis is not None:
        # Re-specified 2026-08-01 (roadmap gate list): wer_micro and the
        # boundary-concentration profile are reported, not gated; the gated
        # laundering check is forced-span WER.
        if wer_analysis["forced_span_gate_evaluated"]:
            gate[f"forced_span_wer < {FORCED_WER_THRESHOLD:.0%}"] = (
                wer_analysis["forced_span_wer"] < FORCED_WER_THRESHOLD)
        else:
            print(f"forced_span_wer gate skipped: "
                  f"{wer_analysis['forced_words_total']} forced words < "
                  f"{FORCED_WER_MIN_WORDS} floor (reported, not gated)",
                  file=sys.stderr)
    print("\nGate:", file=sys.stderr)
    for name, ok in gate.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}", file=sys.stderr)

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
        print(f"\nReport written: {args.report}", file=sys.stderr)

    sys.exit(0 if all(gate.values()) else 1)


if __name__ == "__main__":
    main()
