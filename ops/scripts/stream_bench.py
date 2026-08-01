#!/usr/bin/env python3
"""stream_bench — measurement harness for /ws/stream (v4.0 gate instrument).

Replays a WAV at real-time pace over the streaming protocol and reports the
gate numbers (roadmap v4, docs/v4/protocol.md): first-partial latency,
finalization latency (both anchors), commit-lag distribution, retraction count
(via a reference reducer, C5.1), the final.raw committed-prefix invariant
(C5.3), force-commit rate, dropped_audio_ms, and — with --baseline — the
one-shot comparison (latency, committed-vs-one-shot WER) plus GPU duty cycle
and peak VRAM sampled via nvidia-smi.

All hypothesis comparison happens here, on the client side of the protocol
(C9.2). The JSON report contains counters, latencies, and distributions only —
never transcript text. Fixtures should be synthetic/committed audio
(ops/scripts/test.mp3 pattern), never user audio.

Usage:
    python ops/scripts/stream_bench.py ops/scripts/test.mp3 [--baseline]
        [--url ws://localhost:8084] [--language en] [--frame-ms 96]
        [--utterances 3] [--report bench_report.json]

--utterances N splits the audio into N contiguous segments with a flush after
each — a single-flush replay never exercises the post-flush coordinate path
(peer review 2026-07-31: utterance ≥ 1 partials died and the single-flush
harness certified the build). Gate runs should use N ≥ 3.

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


def norm_words(text: str) -> list[str]:
    out = []
    for tok in text.split():
        t = unicodedata.normalize("NFKC", tok).casefold()
        t = t.strip("".join(c for c in t if unicodedata.category(c).startswith("P")))
        if t:
            out.append(t)
    return out


def wer(ref: list[str], hyp: list[str]) -> float:
    """Word error rate via Levenshtein distance."""
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        curr = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (r != h))
        prev = curr
    return prev[-1] / len(ref)


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
                     frame_ms: int, utterances: int = 1) -> dict:
    frame_samples = int(SR * frame_ms / 1000)
    seg_bounds = np.linspace(0, len(audio), utterances + 1).astype(int)
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
        "errors": [],
    }
    final_raws: list[str] = []

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
        first_partial_lat: float | None = None
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
            nonlocal first_partial_lat
            while not done.is_set():
                msg = json.loads(await ws.recv())
                now = time.monotonic()
                mtype = msg.get("type")
                if mtype == "partial":
                    stats["partials"] += 1
                    if msg["text"]:
                        nonempty_partial_utts.add(msg["utterance_id"])
                        if first_partial_lat is None and t_first_frame:
                            first_partial_lat = now - t_first_frame
                elif mtype == "committed":
                    reducer.on_committed(msg["utterance_id"], msg["text"])
                    n = len(msg["text"].split())
                    stats["committed_words_total"] += n
                    if msg.get("forced"):
                        stats["committed_words_forced"] += n
                    anchor = utt_first_frame.get(msg["utterance_id"], t_first_frame)
                    if anchor:
                        # commit lag: word audibly ended at anchor + t1
                        stats["commit_lag_s"].append(
                            round(now - (anchor + msg["t1"]), 3))
                elif mtype == "final":
                    prior = reducer.committed.get(msg["utterance_id"], "")
                    if prior and not msg["raw"].startswith(prior):
                        stats["prefix_invariant_ok"] = False
                    reducer.on_final(msg["utterance_id"], msg["raw"])
                    final_raws.append(msg["raw"])
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
    stats["first_partial_s"] = round(first_partial_lat, 3) if first_partial_lat else None
    stats["finalization_per_utterance_s"] = finalization_lats
    stats["finalization_from_flush_s"] = max(finalization_lats) if finalization_lats else None
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
    stats["_final_text"] = " ".join(final_raws)  # in-memory only, for WER
    return stats


ONESHOT_MAX_S = 60  # one-shot path audio cap (docs/contract/runtime-contract.md)


def run_baseline(base_url: str, audio: np.ndarray) -> dict:
    """v3 one-shot path on the same audio (hardware cost comparison).

    The one-shot endpoint caps audio at 60 s, so longer recordings are split
    into even chunks under the cap and sent sequentially — the same chunking a
    v3 user has to do by hand. Wall time is the sum across chunks.
    """
    import io
    import urllib.request

    max_samples = ONESHOT_MAX_S * SR
    n_chunks = (len(audio) + max_samples - 1) // max_samples
    boundary = "streambenchboundary"
    total_wall = 0.0
    raws = []
    for chunk in np.array_split(audio, max(1, n_chunks)):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SR)
            wf.writeframes((chunk * 32767.0).astype(np.int16).tobytes())
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
        total_wall += time.monotonic() - t0
        raws.append(payload["raw"])
    return {"oneshot_wall_s": round(total_wall, 3),
            "oneshot_chunks": max(1, n_chunks),
            "_raw": " ".join(raws)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("audio", help="Audio file (anything ffmpeg reads)")
    ap.add_argument("--url", default="ws://localhost:8084")
    ap.add_argument("--http-url", default="http://localhost:8084")
    ap.add_argument("--language", default=None)
    ap.add_argument("--frame-ms", type=int, default=96)
    ap.add_argument("--utterances", type=int, default=1,
                    help="Split the audio into N segments with a flush after each "
                         "(gate runs: >= 3 — exercises the post-flush coordinate path)")
    ap.add_argument("--baseline", action="store_true",
                    help="Also run the v3 one-shot path for the cost comparison")
    ap.add_argument("--report", default=None, help="Write JSON report (counters only)")
    args = ap.parse_args()

    audio = load_audio_f32(args.audio)

    sampler = GpuSampler()
    sampler.start()
    stream_stats = asyncio.run(run_stream(args.url, audio, args.language, args.frame_ms,
                                          args.utterances))
    gpu_stream = sampler.stop()

    report = {"stream": stream_stats, "gpu_during_stream": gpu_stream}

    if args.baseline:
        sampler = GpuSampler()
        sampler.start()
        try:
            baseline = run_baseline(args.http_url, audio)
        except Exception as exc:
            baseline = None
            print(f"baseline failed; continuing with stream stats only: {exc}",
                  file=sys.stderr)
        report["gpu_during_oneshot"] = sampler.stop()
        if baseline is not None:
            report["baseline"] = {k: v for k, v in baseline.items()
                                  if not k.startswith("_")}
            report["committed_vs_oneshot_wer"] = round(
                wer(norm_words(baseline["_raw"]),
                    norm_words(stream_stats["_final_text"])), 4)
    stream_stats.pop("_final_text", None)

    print(json.dumps(report, indent=2))
    gate = {
        "first_partial ≤ 1.5 s": (stream_stats.get("first_partial_s") or 99) <= 1.5,
        "finalization_from_flush ≤ 0.5 s": (
            (stream_stats.get("finalization_from_flush_s") or 99) <= 0.5),
        "retractions == 0": stream_stats["retractions"] == 0,
        "prefix_invariant": stream_stats["prefix_invariant_ok"],
        "dropped_audio_ms == 0": stream_stats["dropped_audio_ms"] == 0,
        "force_commit_rate < 5%": stream_stats["force_commit_rate"] < 0.05,
    }
    if args.utterances > 1:
        gate["partials_in_every_utterance"] = (
            stream_stats["utterances_with_nonempty_partials"] == args.utterances)
    if "committed_vs_oneshot_wer" in report:
        gate["committed_vs_oneshot WER < 3%"] = report["committed_vs_oneshot_wer"] < 0.03
    print("\nGate:", file=sys.stderr)
    for name, ok in gate.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}", file=sys.stderr)

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
        print(f"\nReport written: {args.report}", file=sys.stderr)

    sys.exit(0 if all(gate.values()) else 1)


if __name__ == "__main__":
    main()
