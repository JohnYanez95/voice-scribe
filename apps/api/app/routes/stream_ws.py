"""Streaming transcription session — WS /ws/stream (docs/v4/protocol.md v1).

One asyncio task per session runs the paced decode loop via asyncio.to_thread;
the receive loop stays responsive because faster-whisper releases the GIL in
CTranslate2. No temp files anywhere on this path (protocol §9): audio lives in
a bounded in-memory buffer, released on close, disconnect, and error alike.
No transcript, hypothesis, or audio content is ever logged.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid

import numpy as np
import structlog
from fastapi import APIRouter
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.config import settings
from app.services import stream_guard
from app.services.cleanup import clean_transcript
from app.services.stream_policy import (
    PolicyConfig,
    PolicyState,
    WindowPlan,
    agree,
    committed_text,
    localize,
    plan_window,
    retention_start_sample,
)
from app.services.transcription import get_current_model_name, get_model

log = structlog.get_logger()

router = APIRouter()

CLOSE_POLICY_VIOLATION = 4408
CLOSE_BUSY = 4409

# C7.11 — whitespace tokenization would treat an utterance as one word.
# Sessions pinned to these languages run flush-only: partials shown, commits
# only at flush.
FLUSH_ONLY_LANGUAGES = {"ja", "zh", "th"}

# Flush decodes shorter than this are skipped: sub-100 ms tails are below one
# Whisper frame of usable content and reliably hallucinate.
MIN_FLUSH_DECODE_S = 0.1


def _policy_config() -> PolicyConfig:
    cfg = PolicyConfig(
        sample_rate=settings.STREAM_SAMPLE_RATE,
        left_context_s=settings.STREAM_LEFT_CONTEXT_S,
        max_uncommitted_s=settings.STREAM_MAX_UNCOMMITTED_S,
        word_prob_floor=settings.STREAM_WORD_PROB_FLOOR,
        edge_guard_s=settings.STREAM_EDGE_GUARD_S,
        max_holdback_ticks=settings.STREAM_MAX_HOLDBACK_TICKS,
    )
    cfg.validate()  # C7.1 — env overrides must not reintroduce silent truncation
    return cfg


class StreamSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.ws = websocket
        self.cfg = _policy_config()
        self.sr = self.cfg.sample_rate
        self.session_id = uuid.uuid4().hex[:12]
        self.seq = 0
        self.utterance_id = 0
        self.language: str | None = None
        self.model = None
        self.model_name = ""

        # audio buffer: list of float32 chunks; base_sample = absolute index of
        # the first retained sample (session clock)
        self.chunks: list[np.ndarray] = []
        self.base_sample = 0
        self.total_samples = 0
        self.utterance_start_sample = 0
        self.dropped_audio_ms = 0.0
        self.dropped_edge_sample = 0  # watermark: drops accounted through here
        self.overrun_signaled = False
        self.flush_only = False  # C7.11 — set when a flush-only language is pinned

        self.policy = PolicyState()
        self.send_lock = asyncio.Lock()
        self.decode_lock = asyncio.Lock()
        self.decode_generation = 0  # bumped to invalidate an in-flight tick
        self.decode_task: asyncio.Task | None = None
        self.preempt_event = asyncio.Event()
        # threading.Event, not asyncio: the preemptor may run on a different
        # event loop (one loop per test-client session) and must be able to
        # wait for this session's teardown from there.
        self.closed_event = threading.Event()
        self.loop = asyncio.get_running_loop()

        self.started_mono = time.monotonic()
        self.last_frame_mono = time.monotonic()
        self.first_tick_pending = True  # C7.10 — first tick fires off-grid
        self.frames_since_tick = 0
        self.stopped = False
        self.frames_after_stop = 0
        self.consecutive_overruns = 0
        self.tick_multiplier = 1
        self.ticks_skipped = 0
        self.decode_ms_samples: list[float] = []  # occupancy telemetry (C9.2-safe)

    # -- guard handle protocol (stream_guard.StreamSessionHandle) ----------

    def last_frame_age_s(self) -> float:
        # A session with a decode or flush in flight is actively streaming even
        # if the receive loop hasn't drained a frame recently (C1.4: an actively
        # streaming incumbent is never preempted) — a flush decode blocks the
        # receive loop for longer than PREEMPT_GRACE_S under tick degradation.
        if self.decode_lock.locked():
            return 0.0
        return time.monotonic() - self.last_frame_mono

    def pin_language(self, language: str) -> None:
        """C7.7/C7.11: pin the language and derive the flush-only mode."""
        self.language = language
        self.flush_only = language in FLUSH_ONLY_LANGUAGES

    def request_preempt(self) -> None:
        self.loop.call_soon_threadsafe(self.preempt_event.set)

    # -- send helpers -------------------------------------------------------

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            self.seq += 1
            payload["seq"] = self.seq
            await self.ws.send_json(payload)

    async def send_error(self, code: str, detail: str, fatal: bool) -> None:
        try:
            await self.send({"type": "error", "code": code, "detail": detail, "fatal": fatal})
        except Exception:
            pass  # peer already gone — teardown continues regardless

    async def fail(self, code: str, detail: str, close_code: int = CLOSE_POLICY_VIOLATION) -> None:
        await self.send_error(code, detail, fatal=True)
        try:
            await self.ws.close(code=close_code)
        except Exception:
            pass

    # -- buffer -------------------------------------------------------------

    def append_frame(self, data: bytes) -> None:
        arr = np.frombuffer(data, dtype=np.float32).copy()
        # C2.3: a single NaN poisons the whole decode window
        np.nan_to_num(arr, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        self.chunks.append(arr)
        self.total_samples += len(arr)
        self.last_frame_mono = time.monotonic()
        self.frames_since_tick += 1

    def _trim_buffer(self, keep_from_sample: int) -> None:
        drop = keep_from_sample - self.base_sample
        if drop <= 0:
            return
        remaining = drop
        while self.chunks and remaining >= len(self.chunks[0]):
            remaining -= len(self.chunks.pop(0))
        if self.chunks and remaining > 0:
            self.chunks[0] = self.chunks[0][remaining:]
            remaining = 0
        self.base_sample = keep_from_sample

    def _window_audio(self, start_sample: int) -> np.ndarray:
        offset = start_sample - self.base_sample
        if offset < 0:
            # A caller asked for audio before the retained buffer. Returning
            # the buffer anyway would hand the decoder audio whose coordinates
            # disagree with the requested start — every word would be rebased
            # wrong. Fail loudly instead.
            raise ValueError(
                f"window start {start_sample} precedes buffer base {self.base_sample}"
            )
        audio = np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)
        return audio[offset:]

    def uncommitted_seconds(self) -> float:
        return (self.total_samples - max(self.policy.committed_through_sample,
                                         self.utterance_start_sample)) / self.sr

    # -- decode -------------------------------------------------------------

    def _decode_sync(self, audio: np.ndarray, generation: int, beam_size: int = 5):
        """Runs in a worker thread. Returns (words, language) or None if the
        tick was invalidated (flush/reset/teardown bumped the generation)."""
        kwargs: dict = {
            "beam_size": beam_size,
            "word_timestamps": True,       # C7.6 — trim arithmetic needs them
            "vad_filter": False,           # C7.6 — client gates at the source
            "condition_on_previous_text": False,
        }
        if self.language:
            kwargs["language"] = self.language
        segments, info = self.model.transcribe(audio, **kwargs)
        words: list[tuple[str, float, float, float]] = []
        for seg in segments:
            if self.decode_generation != generation:
                return None  # invalidated mid-iteration — discard hypothesis
            for wd in (seg.words or []):
                words.append((wd.word, wd.start, wd.end, wd.probability))
        if self.decode_generation != generation:
            return None
        return words, info.language

    async def _apply_overflow(self, plan: WindowPlan, committed_edge: int) -> None:
        """C5.6: on overrun, drop the OLDEST uncommitted audio from the buffer
        itself (§6 memory bound — sliding only the decode window leaves the
        bytes resident), account each dropped sample exactly once via the
        watermark, and signal the first drop of the utterance."""
        if plan.overflow_drop_samples <= 0:
            return
        newly_dropped = plan.context_end_sample - max(self.dropped_edge_sample, committed_edge)
        if newly_dropped > 0:
            self.dropped_audio_ms += newly_dropped / self.sr * 1000.0
            self.dropped_edge_sample = plan.context_end_sample
        self._trim_buffer(max(plan.window_start_sample, self.base_sample))
        if not self.overrun_signaled:
            self.overrun_signaled = True
            await self.send_error(
                "overrun", "Decode fell behind ingest; oldest uncommitted audio dropped.",
                fatal=False,
            )

    async def _tick_once(self) -> None:
        committed_edge = max(self.policy.committed_through_sample, self.utterance_start_sample)
        plan = plan_window(committed_edge, self.total_samples, self.cfg)
        await self._apply_overflow(plan, committed_edge)

        # The planned window may start before the retained buffer: after a
        # flush, left context would reach into the previous (cleared)
        # utterance. Decode AND localize from the same clamped start, or every
        # word is rebased into the wrong coordinates.
        window_start = max(plan.window_start_sample, self.base_sample)
        generation = self.decode_generation
        audio = self._window_audio(window_start)
        if len(audio) == 0:
            return
        # C7.4: the edge guard is measured against the audio the decoder saw —
        # frames arriving during the decode must not erode the guard.
        decoded_end_sample = window_start + len(audio)
        start = time.monotonic()
        result = await asyncio.to_thread(self._decode_sync, audio, generation)
        decode_ms = (time.monotonic() - start) * 1000.0
        self.first_tick_pending = False
        self.decode_ms_samples.append(decode_ms)
        if decode_ms > settings.STREAM_DECODE_TICK_MS:
            # Overruns are rare and each one is a ticks_skipped increment —
            # they must explain themselves (duration + window) at warning level.
            log.warning("stream tick overrun", duration_ms=f"{decode_ms:.0f}",
                        window_s=f"{len(audio) / self.sr:.1f}")
        else:
            log.debug("stream tick decode", duration_ms=f"{decode_ms:.0f}",
                      window_s=f"{len(audio) / self.sr:.1f}")

        # C7.8 rule 3: three consecutive overruns double the effective tick
        # (cap 4x, log once per escalation, counter restarts after each)
        if decode_ms > settings.STREAM_DECODE_TICK_MS:
            self.consecutive_overruns += 1
            if self.consecutive_overruns >= 3 and self.tick_multiplier < 4:
                self.tick_multiplier = min(4, self.tick_multiplier * 2)
                self.consecutive_overruns = 0
                log.warning("stream tick interval degraded", multiplier=self.tick_multiplier)
        else:
            self.consecutive_overruns = 0

        if result is None or self.decode_generation != generation:
            return  # flush/reset invalidated this tick
        raw_words, language = result
        if self.language is None and language:
            self.pin_language(language)  # C7.7: pinned from first successful decode

        hyp = localize(raw_words, window_start, plan.context_end_sample, self.cfg)
        if self.flush_only:
            # C7.11: no whitespace tokenization — partials only, commits at flush
            await self.send({
                "type": "partial",
                "utterance_id": self.utterance_id,
                "text": committed_text(hyp),
            })
            return
        decision = agree(self.policy, hyp, decoded_end_sample, self.cfg)
        self.policy = decision.state

        if decision.newly_committed:
            u0 = self.utterance_start_sample / self.sr
            await self.send({
                "type": "committed",
                "utterance_id": self.utterance_id,
                "text": committed_text(decision.newly_committed),
                "t0": round(decision.newly_committed[0].start - u0, 3),
                "t1": round(decision.newly_committed[-1].end - u0, 3),
                "forced": decision.holdback_fired,
            })
            self._trim_buffer(
                retention_start_sample(self.policy.committed_through_sample, self.cfg)
            )
        await self.send({
            "type": "partial",
            "utterance_id": self.utterance_id,
            "text": committed_text(decision.tentative),
        })

    async def decode_loop(self) -> None:
        tick_s = settings.STREAM_DECODE_TICK_MS / 1000.0
        tick_start = time.monotonic()
        while True:
            # C7.10: the first tick of an utterance fires as soon as
            # MIN_DECODE_S is buffered instead of waiting for the tick grid —
            # this is what keeps first-partial ≤ 1.5 s at a 750 ms tick.
            if self.first_tick_pending:
                await asyncio.sleep(0.05)
                tick_start = time.monotonic()
            else:
                # C7.8 rule 2: next tick at max(now, tick_start + tick) — the
                # sleep is anchored to the previous tick START. Sleeping after
                # the decode returns would make the effective period
                # tick + decode_ms and silently slow the whole cadence.
                target = tick_start + tick_s * self.tick_multiplier
                now = time.monotonic()
                if target > now:
                    await asyncio.sleep(target - now)
                tick_start = time.monotonic()
            # C7.10: skip idle ticks — near-silence decodes hallucinate
            if self.frames_since_tick == 0:
                continue
            if self.uncommitted_seconds() < settings.STREAM_MIN_DECODE_S:
                continue
            self.frames_since_tick = 0
            async with self.decode_lock:  # C7.8 rule 1: one decode in flight
                try:
                    await self._tick_once()
                except Exception as e:
                    log.error("stream tick failed", error=str(e))
                    await self.send_error("decode_failure", "Streaming decode failed.", fatal=False)
            if time.monotonic() - tick_start > tick_s * self.tick_multiplier:
                self.ticks_skipped += 1  # C7.8 rule 2: the decode overran its grid slot

    # -- utterance boundaries -----------------------------------------------

    async def do_flush(self, forced: bool = False) -> None:
        """C3.3/C7.9: cancel the in-flight tick, decode the uncommitted buffer
        once, finalize, keep the session alive."""
        self.decode_generation += 1  # invalidate in-flight tick
        drain_start = time.monotonic()
        async with self.decode_lock:
            # C7.9: flush latency = cancel drain + one decode; the drain is
            # the wait for the invalidated in-flight tick to release the lock.
            drain_ms = (time.monotonic() - drain_start) * 1000.0
            committed_edge = max(self.policy.committed_through_sample,
                                 self.utterance_start_sample)
            # C5.2 + C7.1: the flush decodes the uncommitted buffer only, and
            # never a window larger than the planner allows. After an overrun
            # the flush starts at the effective (slid) edge — decoding audio
            # the client was told was dropped would make the message log and
            # the emitted text disagree.
            plan = plan_window(committed_edge, self.total_samples, self.cfg)
            await self._apply_overflow(plan, committed_edge)
            flush_start = max(plan.context_end_sample, self.base_sample)
            audio = self._window_audio(flush_start)
            tail_words = ()
            language = self.language or ""
            flush_decode_ms = 0.0
            if len(audio) >= int(MIN_FLUSH_DECODE_S * self.sr):
                generation = self.decode_generation
                decode_start = time.monotonic()
                try:
                    result = await asyncio.to_thread(self._decode_sync, audio, generation)
                except Exception as e:
                    # A flush-decode failure must not crash the session: emit
                    # the error, finalize with committed text only (the
                    # uncommitted tail is lost, and we say so via the error).
                    log.error("stream flush decode failed", error=str(e))
                    await self.send_error(
                        "decode_failure",
                        "Flush decode failed; finalizing committed text only.",
                        fatal=False,
                    )
                    result = None
                flush_decode_ms = (time.monotonic() - decode_start) * 1000.0
                if result is not None:
                    raw_words, detected = result
                    if self.language is None and detected:
                        self.pin_language(detected)
                        language = detected
                    tail_words = localize(raw_words, flush_start, flush_start, self.cfg)

            log.info("stream flush", utterance_id=self.utterance_id,
                     drain_ms=f"{drain_ms:.0f}",
                     decode_ms=f"{flush_decode_ms:.0f}",
                     window_s=f"{len(audio) / self.sr:.1f}")
            prior = committed_text(self.policy.committed_words)
            tail = committed_text(tail_words)
            raw = f"{prior} {tail}".strip() if prior and tail else (prior or tail)
            duration = (self.total_samples - self.utterance_start_sample) / self.sr

            await self.send({
                "type": "final",
                "utterance_id": self.utterance_id,
                "raw": raw,
                "cleaned": clean_transcript(raw),
                "language": self.language or language,
                "duration": round(duration, 3),
                "model_name": self.model_name,
                "processing_mode": settings.DEVICE,
                "dropped_audio_ms": round(self.dropped_audio_ms, 1),
                "forced": forced,
            })
            self._next_utterance()

    def _next_utterance(self) -> None:
        self.utterance_id += 1
        self.policy = PolicyState()
        self.utterance_start_sample = self.total_samples
        self.dropped_audio_ms = 0.0
        self.dropped_edge_sample = self.total_samples
        self.overrun_signaled = False
        self.first_tick_pending = True
        self.chunks = []
        self.base_sample = self.total_samples

    async def do_reset(self) -> None:
        """C3.6: drop uncommitted AND committed state for the current
        utterance; no final; acked."""
        self.decode_generation += 1
        async with self.decode_lock:
            old_utterance = self.utterance_id
            self._next_utterance()
        await self.send({"type": "ack", "of": "reset", "utterance_id": old_utterance})

    # -- ingest validation ----------------------------------------------------

    def frame_problem(self, data: bytes) -> tuple[str, str] | None:
        if len(data) == 0:
            return "protocol_violation", "Empty frame."
        if len(data) > settings.STREAM_MAX_FRAME_BYTES:
            return "frame_too_large", (
                f"Frame of {len(data)} bytes exceeds max {settings.STREAM_MAX_FRAME_BYTES}."
            )
        if len(data) % 4 != 0:
            return "protocol_violation", "Frame byte length must be a multiple of 4 (pcm_f32le)."
        # C2.5: sustained ingest above 2x real-time is a live-capture violation
        received_s = self.total_samples / self.sr
        elapsed_s = time.monotonic() - self.started_mono
        if received_s > 2.0 * elapsed_s + 10.0:
            return "protocol_violation", "Ingest rate exceeds 2x real-time."
        return None


def _validate_start(text: str) -> tuple[dict | None, tuple[str, str] | None]:
    try:
        msg = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None, ("protocol_violation", "First message must be JSON.")
    if not isinstance(msg, dict) or msg.get("type") != "start":
        return None, ("protocol_violation", "First message must be a start control message.")
    if msg.get("protocol_version") != settings.STREAM_PROTOCOL_VERSION:
        return None, ("unsupported_version",
                      f"Unsupported protocol_version; server speaks {settings.STREAM_PROTOCOL_VERSION}.")
    if msg.get("sample_format") != settings.STREAM_SAMPLE_FORMAT:
        return None, ("unsupported_format",
                      f"Unsupported sample_format; server accepts {settings.STREAM_SAMPLE_FORMAT}.")
    if msg.get("sample_rate") != settings.STREAM_SAMPLE_RATE:
        return None, ("unsupported_format",
                      f"Unsupported sample_rate; server accepts {settings.STREAM_SAMPLE_RATE}.")
    return msg, None


@router.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket) -> None:
    # C1.2 — origin enforcement before accept (CORSMiddleware does not cover WS)
    origin = websocket.headers.get("origin", "")
    if origin not in settings.cors_origins:
        log.warning("ws_stream: rejected disallowed origin", origin=origin)
        await websocket.close(code=4003)
        return

    await websocket.accept()
    session = StreamSession(websocket)
    acquired = False
    try:
        # ---- handshake: start → (slot) → ready (C3.1, C4.1) ----
        try:
            first = await asyncio.wait_for(
                websocket.receive(), timeout=settings.STREAM_IDLE_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            await session.fail("session_timeout", "No start message received.")
            return
        if first.get("type") == "websocket.disconnect":
            return
        if first.get("bytes") is not None:
            # C2.4 — frames before start are a protocol violation
            await session.fail("protocol_violation", "Binary frame received before start.")
            return
        start_msg, problem = _validate_start(first.get("text") or "")
        if problem:
            await session.fail(*problem)
            return
        client_language = start_msg.get("language") or None
        if client_language:
            session.pin_language(client_language)

        # ---- one-session rule (C1.3–C1.4) ----
        status, incumbent = stream_guard.try_acquire_stream(
            session, settings.STREAM_PREEMPT_GRACE_S
        )
        if status in ("busy", "model_swapping"):
            detail = ("Another stream session is active." if status == "busy"
                      else "A model swap is in progress.")
            await session.fail(status, detail, close_code=CLOSE_BUSY)
            return
        acquired = True
        if status == "preempting" and incumbent is not None:
            done = await asyncio.to_thread(incumbent.closed_event.wait, 5.0)
            if not done:
                # C1.7: proceeding would put two sessions on the GPU — fail
                # the newcomer instead. (The finally: release is identity-
                # checked, so it cannot clear a later session's registration.)
                log.warning("stream preemption: incumbent teardown timed out; "
                            "rejecting newcomer")
                await session.fail("busy", "Incumbent session teardown timed out.",
                                   close_code=CLOSE_BUSY)
                return

        # C7.7 — model resolved once, held for the session
        session.model = get_model()
        session.model_name = get_current_model_name() or ""

        await session.send({
            "type": "ready",
            "protocol_version": settings.STREAM_PROTOCOL_VERSION,
            "session_id": session.session_id,
            "sample_rate": session.sr,
            "sample_format": settings.STREAM_SAMPLE_FORMAT,
            "max_frame_bytes": settings.STREAM_MAX_FRAME_BYTES,
            "model_name": session.model_name,
            "language": session.language,
            "decode_tick_ms": settings.STREAM_DECODE_TICK_MS,
            "max_uncommitted_s": settings.STREAM_MAX_UNCOMMITTED_S,
            "max_holdback_ticks": settings.STREAM_MAX_HOLDBACK_TICKS,
        })
        session.decode_task = asyncio.create_task(session.decode_loop())

        # ---- main loop ----
        preempt_wait = asyncio.ensure_future(session.preempt_event.wait())
        try:
            while True:
                recv = asyncio.ensure_future(websocket.receive())
                done, _ = await asyncio.wait(
                    {recv, preempt_wait},
                    timeout=settings.STREAM_IDLE_TIMEOUT_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if preempt_wait in done:
                    recv.cancel()
                    await session.send_error("preempted", "Preempted by a new session.", fatal=True)
                    try:
                        await websocket.close(code=CLOSE_BUSY)
                    except Exception:
                        pass
                    return
                if recv not in done:
                    recv.cancel()
                    await session.fail("session_timeout", "Session idle timeout.")
                    return
                message = recv.result()
                if message.get("type") == "websocket.disconnect":
                    log.info("stream client disconnected mid-session")
                    return
                if time.monotonic() - session.started_mono > settings.STREAM_MAX_SESSION_S:
                    await session.do_flush(forced=True)
                    await session.fail("session_timeout", "Session exceeded maximum duration.")
                    return

                data = message.get("bytes")
                if data is not None:
                    if session.stopped:
                        session.frames_after_stop += 1  # C2.4 — dropped, counted
                        continue
                    problem = session.frame_problem(data)
                    if problem:
                        await session.fail(*problem)
                        return
                    session.append_frame(data)
                    utterance_s = (session.total_samples - session.utterance_start_sample) / session.sr
                    if utterance_s >= settings.STREAM_MAX_UTTERANCE_S:
                        await session.do_flush(forced=True)  # C3.4
                    continue

                text = message.get("text")
                try:
                    control = json.loads(text) if text else None
                except json.JSONDecodeError:
                    control = None
                ctype = control.get("type") if isinstance(control, dict) else None
                if ctype == "flush":
                    await session.do_flush()
                elif ctype == "reset":
                    await session.do_reset()
                elif ctype == "stop":
                    session.stopped = True
                    if session.uncommitted_seconds() > 0 or session.policy.committed_words:
                        await session.do_flush()
                    await session.send({
                        "type": "ack", "of": "stop",
                        "utterance_id": session.utterance_id,
                        "frames_dropped_after_stop": session.frames_after_stop,
                    })
                    try:
                        await websocket.close(code=1000)
                    except Exception:
                        pass
                    return
                else:
                    await session.fail("protocol_violation",
                                       "Unknown or out-of-order control message.")
                    return
        finally:
            preempt_wait.cancel()

    except WebSocketDisconnect:
        log.info("stream client disconnected")
    finally:
        # C1.7/C8.2 — teardown order: invalidate decode, await the task, THEN
        # release the slot; clear the buffer on every exit path.
        session.decode_generation += 1
        if session.decode_task is not None:
            session.decode_task.cancel()
            try:
                await asyncio.gather(session.decode_task, return_exceptions=True)
            except Exception:
                pass
        session.chunks = []
        if acquired:
            stream_guard.release_stream(session)
        session.closed_event.set()
        # Occupancy and skip counters are server-internal; this line is how a
        # gate/field-test run observes them (counters only — C9.2).
        samples = sorted(session.decode_ms_samples)
        occupancy_p95 = (
            round(samples[int(0.95 * (len(samples) - 1))] / settings.STREAM_DECODE_TICK_MS, 3)
            if samples else None
        )
        # p95 is blind to the overrun tail by construction (2 of ~290 ticks sit
        # at ~p99.3) — the max is what sees a breach.
        occupancy_max = (
            round(samples[-1] / settings.STREAM_DECODE_TICK_MS, 3) if samples else None
        )
        log.info("stream session closed", session_id=session.session_id,
                 ticks=len(samples), ticks_skipped=session.ticks_skipped,
                 tick_multiplier=session.tick_multiplier,
                 occupancy_p95=occupancy_p95, occupancy_max=occupancy_max,
                 decode_ms_max=round(samples[-1], 1) if samples else None,
                 decode_seconds_total=round(sum(samples) / 1000.0, 1))
