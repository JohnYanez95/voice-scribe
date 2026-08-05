"""Session tests for /ws/stream (docs/v4/protocol.md v1).

Same model-mocking pattern as the other backend tests — no CUDA. Each test
names the protocol clause it enforces.
"""
import json
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.main import app
from app.services import stream_guard

client = TestClient(app, raise_server_exceptions=False)

ALLOWED_ORIGIN = "http://localhost:5174"
HEADERS = {"origin": ALLOWED_ORIGIN}

START = {
    "type": "start",
    "protocol_version": 1,
    "sample_format": "pcm_f32le",
    "sample_rate": 16000,
    "language": "en",
}


def pcm(seconds: float) -> bytes:
    return np.zeros(int(seconds * 16000), dtype=np.float32).tobytes()


def make_model(word_tuples):
    """Model whose transcribe() returns the given (text, start, end, prob)
    words on every call — fresh iterators each time."""
    def transcribe(audio, **kwargs):
        words = [SimpleNamespace(word=f" {t}", start=s, end=e, probability=p)
                 for t, s, e, p in word_tuples]
        segs = iter([SimpleNamespace(words=words, text="")])
        info = SimpleNamespace(language="en", duration=len(audio) / 16000)
        return segs, info
    m = MagicMock()
    m.transcribe.side_effect = transcribe
    return m


@pytest.fixture(autouse=True)
def fast_stream_settings(monkeypatch):
    """Small timers so sessions are responsive under test; guard state clean."""
    monkeypatch.setattr(settings, "STREAM_DECODE_TICK_MS", 20)
    monkeypatch.setattr(settings, "STREAM_IDLE_TIMEOUT_S", 5.0)
    yield
    # a failed test must not leak the slot into the next one (C8.2 mirror)
    stream_guard._active_session = None
    stream_guard._swap_in_progress = False


def connect(ws_client=client, query=""):
    return ws_client.websocket_connect(f"/ws/stream{query}", headers=HEADERS)


def start_session(ws, start_msg=START):
    ws.send_text(json.dumps(start_msg))
    return ws.receive_json()


# ---------------------------------------------------------------------------
# C1.2 — origin enforcement, pre-accept close 4003
# ---------------------------------------------------------------------------

def test_rejects_disallowed_origin_with_4003():
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/stream", headers={"origin": "http://evil.example.com"}):
            pass
    assert exc_info.value.code == 4003


# ---------------------------------------------------------------------------
# C3.1 / C4.1 — handshake: start → ready with config echo
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_start_yields_ready_with_tunables_echo(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        ready = start_session(ws)
        assert ready["type"] == "ready"
        assert ready["seq"] == 1
        assert ready["protocol_version"] == 1
        assert ready["sample_format"] == "pcm_f32le"
        assert ready["sample_rate"] == 16000
        assert ready["model_name"] == "large-v3"
        assert ready["decode_tick_ms"] == settings.STREAM_DECODE_TICK_MS
        assert ready["max_holdback_ticks"] == settings.STREAM_MAX_HOLDBACK_TICKS
        ws.send_text(json.dumps({"type": "stop"}))
        assert ws.receive_json()["type"] == "ack"


# C7.7 — model resolved once per session
@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_model_resolved_once_per_session(mock_get_model, _name):
    mock_get_model.return_value = make_model([("hi", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "flush"}))
        while ws.receive_json()["type"] != "final":
            pass
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "flush"}))
        while ws.receive_json()["type"] != "final":
            pass
    assert mock_get_model.call_count == 1


# ---------------------------------------------------------------------------
# C3.2 / C2.1 — version and format negotiation, reject not coerce
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("field,value,code", [
    ("protocol_version", 99, "unsupported_version"),
    ("sample_format", "pcm_s16le", "unsupported_format"),
    ("sample_rate", 44100, "unsupported_format"),
])
def test_start_rejects_unsupported_config(field, value, code):
    with connect() as ws:
        msg = start_session(ws, {**START, field: value})
        assert msg["type"] == "error"
        assert msg["code"] == code
        assert msg["fatal"] is True


def test_malformed_first_message_is_protocol_violation():
    with connect() as ws:
        ws.send_text("not json {")
        msg = ws.receive_json()
        assert msg["code"] == "protocol_violation"


# C2.4 — frames before start
def test_frames_before_start_are_protocol_violation():
    with connect() as ws:
        ws.send_bytes(pcm(0.1))
        msg = ws.receive_json()
        assert msg["type"] == "error"
        assert msg["code"] == "protocol_violation"
        assert msg["fatal"] is True


# ---------------------------------------------------------------------------
# C2.2 — frame validity, checked before buffering
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_empty_frame_rejected(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(b"")
        msg = ws.receive_json()
        assert msg["code"] == "protocol_violation"


@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_oversized_frame_rejected(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(b"\x00" * (settings.STREAM_MAX_FRAME_BYTES + 4))
        msg = ws.receive_json()
        assert msg["code"] == "frame_too_large"


@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_frame_not_multiple_of_sample_width_rejected(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(b"\x00" * 1001)
        msg = ws.receive_json()
        assert msg["code"] == "protocol_violation"


# C3.7 — out-of-order / unknown control
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_unknown_control_message_is_protocol_violation(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        ws.send_text(json.dumps({"type": "start"}))  # second start
        msg = ws.receive_json()
        assert msg["code"] == "protocol_violation"


# ---------------------------------------------------------------------------
# C3.3 / C4.4 — flush: final, session stays alive, utterance_id bumps
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_flush_emits_final_and_keeps_session_alive(mock_get_model, _name):
    mock_get_model.return_value = make_model([
        ("hello", 0.1, 0.3, 0.95), ("world", 0.4, 0.6, 0.95),
    ])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(1.0))
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["type"] == "final"
        assert msg["utterance_id"] == 0
        assert msg["raw"] == "hello world"
        assert msg["cleaned"].startswith("Hello")
        assert msg["duration"] == pytest.approx(1.0, abs=0.01)
        assert msg["forced"] is False
        assert msg["dropped_audio_ms"] == 0

        # session survives the flush — next utterance works
        ws.send_bytes(pcm(1.0))
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["type"] == "final"
        assert msg["utterance_id"] == 1


# C4.4 — duration from frame count, not the decoder
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_final_duration_comes_from_frame_count(mock_get_model, _name):
    mock_get_model.return_value = make_model([("word", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        for _ in range(3):
            ws.send_bytes(pcm(0.7))
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["duration"] == pytest.approx(2.1, abs=0.01)


# ---------------------------------------------------------------------------
# C5.1 / C5.3 — committed is append-only; final.raw carries it as a prefix
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_committed_then_final_prefix_invariant(mock_get_model, _name):
    words = [("the", 0.1, 0.4, 0.95), ("quick", 0.5, 0.9, 0.95),
             ("brown", 1.0, 1.4, 0.95), ("tail", 1.5, 1.8, 0.95)]
    mock_get_model.return_value = make_model(words)
    with connect() as ws:
        start_session(ws)
        # two ticks must both see fresh audio: batch → tick 1 (all tentative,
        # prev hypothesis recorded) → batch → tick 2 (agreement → commit).
        # frames stay ≤ MAX_FRAME_BYTES (1.0 s of f32 = 64000 bytes)
        ws.send_bytes(pcm(1.0))
        msg = ws.receive_json()
        while msg["type"] != "partial":
            msg = ws.receive_json()
        ws.send_bytes(pcm(1.0))
        committed = []
        while True:
            msg = ws.receive_json()
            assert msg["type"] in ("partial", "committed"), f"unexpected {msg}"
            if msg["type"] == "committed":
                committed.append(msg["text"])
                break

        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            if msg["type"] == "committed":
                committed.append(msg["text"])
            msg = ws.receive_json()
        assert msg["type"] == "final"
        prefix = " ".join(committed)
        assert msg["raw"].startswith(prefix), (
            f"final.raw {msg['raw']!r} does not start with committed {prefix!r}"
        )


# ---------------------------------------------------------------------------
# C3.5 — stop: implicit flush, ack, close 1000
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_stop_flushes_acks_and_closes(mock_get_model, _name):
    mock_get_model.return_value = make_model([("bye", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "stop"}))
        types = []
        while True:
            msg = ws.receive_json()
            types.append(msg["type"])
            if msg["type"] == "ack":
                assert msg["of"] == "stop"
                break
        assert "final" in types  # implicit flush before the ack


# ---------------------------------------------------------------------------
# C3.6 — reset: destructive, acked, no final, utterance_id bumps
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_reset_acks_without_final_and_bumps_utterance(mock_get_model, _name):
    mock_get_model.return_value = make_model([("gone", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(1.0))
        ws.send_text(json.dumps({"type": "reset"}))
        msg = ws.receive_json()
        while msg["type"] == "partial":
            msg = ws.receive_json()
        assert msg["type"] == "ack"
        assert msg["of"] == "reset"
        # C4.6 — ack carries the id in force AFTER the control was applied
        # (post-bump, uniform with stop)
        assert msg["utterance_id"] == 1

        # post-reset utterance is clean: duration counts new audio only
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["utterance_id"] == 1
        assert msg["duration"] == pytest.approx(0.5, abs=0.01)


# ---------------------------------------------------------------------------
# C1.3 — one-session rule: busy is observable (post-accept), close 4409
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_second_session_rejected_busy_4409(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws1:
        start_session(ws1)
        with connect() as ws2:
            msg = start_session(ws2)
            assert msg["type"] == "error"
            assert msg["code"] == "busy"
            assert msg["fatal"] is True
        ws1.send_text(json.dumps({"type": "stop"}))
        assert ws1.receive_json()["type"] == "ack"


# C1.4 — preemption of a frame-silent incumbent
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_stale_incumbent_is_preempted(mock_get_model, _name, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_PREEMPT_GRACE_S", 0.0)
    mock_get_model.return_value = make_model([])
    with connect() as ws1:
        start_session(ws1)
        with connect() as ws2:
            ready2 = start_session(ws2)
            assert ready2["type"] == "ready"
            msg1 = ws1.receive_json()
            assert msg1["type"] == "error"
            assert msg1["code"] == "preempted"
            ws2.send_text(json.dumps({"type": "stop"}))
            assert ws2.receive_json()["type"] == "ack"


# C8.1 — stream start during swap rejected
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_stream_start_during_swap_rejected(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    assert stream_guard.try_begin_swap()
    try:
        with connect() as ws:
            msg = start_session(ws)
            assert msg["type"] == "error"
            assert msg["code"] == "model_swapping"
    finally:
        stream_guard.end_swap()


# C8.1 — swap during active stream → HTTP 409
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_swap_during_active_stream_returns_409(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    from app.services import transcription
    original = transcription.AVAILABLE_MODELS
    transcription.AVAILABLE_MODELS = ["large-v3", "small"]
    try:
        with connect() as ws:
            start_session(ws)
            with patch("app.routes.models.get_current_model_name", return_value="large-v3"):
                resp = client.post("/models/swap", json={"model_name": "small"})
            assert resp.status_code == 409
            ws.send_text(json.dumps({"type": "stop"}))
            assert ws.receive_json()["type"] == "ack"
    finally:
        transcription.AVAILABLE_MODELS = original


# ---------------------------------------------------------------------------
# C1.7 / C8.2 — disconnect cleanup: slot freed, next session connects
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_disconnect_frees_slot_and_next_session_connects(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.5))
    # context exit = client disconnect; teardown runs in the session's portal
    deadline = time.monotonic() + 5.0
    while stream_guard.stream_active() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not stream_guard.stream_active(), "slot leaked after disconnect (C8.2)"

    with connect() as ws2:
        ready = start_session(ws2)
        assert ready["type"] == "ready"
        ws2.send_text(json.dumps({"type": "stop"}))
        assert ws2.receive_json()["type"] == "ack"


# ---------------------------------------------------------------------------
# C3.4 — forced flush at MAX_UTTERANCE_S
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_forced_flush_at_max_utterance(mock_get_model, _name, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_MAX_UTTERANCE_S", 1.0)
    mock_get_model.return_value = make_model([("long", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.6))
        ws.send_bytes(pcm(0.6))  # crosses 1.0 s → server force-flushes
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["type"] == "final"
        assert msg["forced"] is True


# ===========================================================================
# Peer-review regression tests (2026-07-31) — findings from the v4.0
# post-implementation review. Each names the clause or finding it closes.
# ===========================================================================

import asyncio
from unittest.mock import AsyncMock

from app import schemas
from app.routes.stream_ws import StreamSession

MODEL_BY_TYPE = {
    "ready": schemas.WsStreamReadyMessage,
    "partial": schemas.WsStreamPartialMessage,
    "committed": schemas.WsStreamCommittedMessage,
    "final": schemas.WsStreamFinalMessage,
    "error": schemas.WsStreamErrorMessage,
    "ack": schemas.WsStreamAckMessage,
}


# C7.2 — after a flush, plan_window reaches left-context seconds below the
# trimmed buffer; decode and localize must share the clamped start, or every
# utterance after the first emits empty partials and misaligned commits.
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_second_utterance_partials_and_commits(mock_get_model, _name):
    mock_get_model.return_value = make_model([
        ("alpha", 0.1, 0.5, 0.95), ("beta", 0.6, 1.0, 0.95), ("gamma", 1.1, 1.4, 0.95),
    ])
    with connect() as ws:
        start_session(ws)
        # utterance 0: tick, then flush
        ws.send_bytes(pcm(1.0))
        msg = ws.receive_json()
        while msg["type"] != "partial":
            msg = ws.receive_json()
        assert msg["text"] != ""
        ws.send_text(json.dumps({"type": "flush"}))
        while msg["type"] != "final":
            msg = ws.receive_json()

        # utterance 1: the first tick must produce a non-empty partial
        ws.send_bytes(pcm(1.0))
        msg = ws.receive_json()
        while msg["type"] not in ("partial", "committed"):
            msg = ws.receive_json()
        assert msg["utterance_id"] == 1
        assert msg["text"] != "", "utterance 1 decoded against shifted coordinates"

        # second tick: agreement commits with utterance-relative timestamps
        ws.send_bytes(pcm(1.0))
        while msg["type"] != "committed":
            msg = ws.receive_json()
        assert msg["utterance_id"] == 1
        assert msg["text"].startswith("alpha")
        assert msg["t0"] == pytest.approx(0.1, abs=0.05)

        ws.send_text(json.dumps({"type": "stop"}))
        while msg["type"] != "ack":
            msg = ws.receive_json()


# C7.11 — sessions pinned to a non-space-delimited language run flush-only:
# partials shown, commits only at flush.
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_flush_only_language_never_commits(mock_get_model, _name):
    mock_get_model.return_value = make_model([
        ("alpha", 0.1, 0.5, 0.95), ("beta", 0.6, 1.0, 0.95),
        ("gamma", 1.1, 1.5, 0.95), ("delta", 1.6, 1.9, 0.95),
    ])
    with connect() as ws:
        start_session(ws, {**START, "language": "ja"})
        seen_types = set()
        ws.send_bytes(pcm(1.0))
        msg = ws.receive_json()
        seen_types.add(msg["type"])
        assert msg["type"] == "partial" and msg["text"] != ""
        ws.send_bytes(pcm(1.0))  # would commit on this tick in a spaced language
        msg = ws.receive_json()
        seen_types.add(msg["type"])
        ws.send_text(json.dumps({"type": "flush"}))
        while msg["type"] != "final":
            msg = ws.receive_json()
            seen_types.add(msg["type"])
        assert "committed" not in seen_types
        assert msg["raw"] != ""
        ws.send_text(json.dumps({"type": "stop"}))
        while msg["type"] != "ack":
            msg = ws.receive_json()


# C1.5 — idle timeout tears the session down and frees the slot (this, not
# TCP keepalive, is what recovers from a client crash).
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_idle_timeout_tears_down_and_frees_slot(mock_get_model, _name, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_IDLE_TIMEOUT_S", 0.3)
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        msg = ws.receive_json()  # no frames, no controls — server must act
        assert msg["type"] == "error"
        assert msg["code"] == "session_timeout"
        assert msg["fatal"] is True
    deadline = time.monotonic() + 5.0
    while stream_guard.stream_active() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not stream_guard.stream_active(), "slot leaked after idle timeout"
    with connect() as ws2:
        assert start_session(ws2)["type"] == "ready"
        ws2.send_text(json.dumps({"type": "stop"}))
        assert ws2.receive_json()["type"] == "ack"


# C2.3 — non-finite samples are sanitized on ingest; the decoder never sees
# NaN/Inf and the session survives.
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_non_finite_samples_sanitized_before_decode(mock_get_model, _name):
    seen = []

    def transcribe(audio, **kwargs):
        seen.append(np.array(audio, copy=True))
        return iter([SimpleNamespace(words=[], text="")]), SimpleNamespace(
            language="en", duration=len(audio) / 16000)

    m = MagicMock()
    m.transcribe.side_effect = transcribe
    mock_get_model.return_value = m
    bad = np.ones(16000, dtype=np.float32)
    bad[::3] = np.nan
    bad[1::5] = np.inf
    bad[2::7] = -np.inf
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(bad.tobytes())
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] not in ("final", "error"):
            msg = ws.receive_json()
        assert msg["type"] == "final"
        ws.send_text(json.dumps({"type": "stop"}))
        while msg["type"] != "ack":
            msg = ws.receive_json()
    assert seen, "decode never ran"
    assert all(np.isfinite(a).all() for a in seen)


# C1.6 — session wall-clock ceiling: implicit forced flush, final, then
# fatal session_timeout.
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_session_ceiling_forced_final_then_timeout(mock_get_model, _name, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_MAX_SESSION_S", 0.2)
    mock_get_model.return_value = make_model([("word", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.5))
        time.sleep(0.3)
        ws.send_bytes(pcm(0.1))  # first message past the ceiling triggers it
        saw_forced_final = False
        while True:
            msg = ws.receive_json()
            if msg["type"] == "final":
                saw_forced_final = msg["forced"]
            if msg["type"] == "error":
                assert msg["code"] == "session_timeout"
                assert msg["fatal"] is True
                break
        assert saw_forced_final is True


# C5.6 / §6 — overrun must trim the buffer itself (memory bound) and account
# each dropped sample exactly once; exactly one overrun error per utterance.
def test_overrun_trims_buffer_and_accounts_drops_exactly_once(monkeypatch):
    monkeypatch.setattr(settings, "STREAM_MAX_UNCOMMITTED_S", 1.0)
    monkeypatch.setattr(settings, "STREAM_LEFT_CONTEXT_S", 0.5)
    # C7.12 validate(): flush left context may never exceed the retention bound
    monkeypatch.setattr(settings, "STREAM_FLUSH_LEFT_CONTEXT_S", 0.5)

    def transcribe(audio, **kwargs):
        return iter([]), SimpleNamespace(language="en", duration=len(audio) / 16000)

    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)
        s.model = SimpleNamespace(transcribe=transcribe)
        for _ in range(4):
            s.append_frame(pcm(1.0))
            await s._tick_once()
        buffered_s = sum(len(c) for c in s.chunks) / s.sr
        assert buffered_s <= s.cfg.left_context_s + s.cfg.max_uncommitted_s + 1e-6, (
            "overrun slid the window but left the bytes resident")
        assert s.dropped_audio_ms == pytest.approx(3000.0, abs=1.0), (
            "dropped_audio_ms must be watermarked, not re-added every tick")
        await s.do_flush()
        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        errors = [p for p in payloads if p["type"] == "error"]
        assert [e["code"] for e in errors] == ["overrun"]
        assert errors[0]["fatal"] is False
        finals = [p for p in payloads if p["type"] == "final"]
        assert len(finals) == 1
        assert finals[0]["dropped_audio_ms"] == pytest.approx(3000.0, abs=1.0)
        # C11.1 — every emitted payload validates against its exported schema
        for p in payloads:
            MODEL_BY_TYPE[p["type"]](**p)

    asyncio.run(run())


# C7.4 — the edge guard anchors to the audio the decoder saw; frames arriving
# during the decode must not erode the guard.
def test_edge_guard_anchored_to_decoded_audio():
    words = [("alpha", 0.1, 0.5, 0.95), ("beta", 1.8, 2.3, 0.95),
             ("gamma", 2.4, 2.7, 0.95)]

    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)

        def transcribe(audio, **kwargs):
            s.append_frame(pcm(0.75))  # ingest continues mid-decode
            wlist = [SimpleNamespace(word=f" {t}", start=st, end=e, probability=p)
                     for t, st, e, p in words]
            return iter([SimpleNamespace(words=wlist, text="")]), SimpleNamespace(
                language="en", duration=len(audio) / 16000)

        s.model = SimpleNamespace(transcribe=transcribe)
        s.append_frame(pcm(2.0))
        await s._tick_once()  # records prev hypothesis
        await s._tick_once()  # agreement: beta (2.3 s) is inside the guard of
        # the decoded 2.75 s window — but not of the post-ingest 3.5 s buffer
        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        committed = [p["text"] for p in payloads if p["type"] == "committed"]
        assert committed == ["alpha"], (
            "edge guard must anchor to decoded audio, not the live buffer")

    asyncio.run(run())


# C1.4 — an actively streaming incumbent is never preempted: a session with a
# decode or flush in flight reports zero frame age to the guard.
def test_decode_in_flight_counts_as_active_for_preemption():
    async def run():
        s = StreamSession(AsyncMock())
        s.last_frame_mono = time.monotonic() - 100.0
        assert s.last_frame_age_s() > 50.0
        async with s.decode_lock:
            assert s.last_frame_age_s() == 0.0

    asyncio.run(run())


# C8.1 — two concurrent swaps must not both pass the guard: the first
# end_swap() would clear the flag while the second is still loading.
def test_concurrent_swap_rejected():
    assert stream_guard.try_begin_swap()
    try:
        assert not stream_guard.try_begin_swap()
    finally:
        stream_guard.end_swap()
    assert stream_guard.try_begin_swap()
    stream_guard.end_swap()


# C11.1 — the wire is hand-built dicts; every message type emitted in a
# normal session must round-trip through its exported Pydantic model.
@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_wire_messages_validate_against_exported_schemas(mock_get_model, _name):
    mock_get_model.return_value = make_model([
        ("the", 0.1, 0.4, 0.95), ("quick", 0.5, 0.9, 0.95),
        ("brown", 1.0, 1.4, 0.95), ("tail", 1.5, 1.8, 0.95)])
    collected = []
    with connect() as ws:

        def recv():
            m = ws.receive_json()
            collected.append(m)
            return m

        collected.append(start_session(ws))  # ready
        ws.send_bytes(pcm(1.0))
        msg = recv()
        while msg["type"] != "partial":
            msg = recv()
        ws.send_bytes(pcm(1.0))
        while msg["type"] != "committed":
            msg = recv()
        ws.send_text(json.dumps({"type": "stop"}))
        while msg["type"] != "ack":
            msg = recv()
    assert {"ready", "partial", "committed", "final", "ack"} <= {m["type"] for m in collected}
    for m in collected:
        MODEL_BY_TYPE[m["type"]](**m)


# ---------------------------------------------------------------------------
# C3.8 — ping keepalive; C4.1 — ready advertises idle_timeout_s
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_ready_advertises_idle_timeout(mock_get_model, _name):
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        ready = start_session(ws)
        assert ready["idle_timeout_s"] == settings.STREAM_IDLE_TIMEOUT_S
        ws.send_text(json.dumps({"type": "stop"}))
        assert ws.receive_json()["type"] == "ack"


@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_ping_resets_idle_timer(mock_get_model, _name, monkeypatch):
    """C3.8: a silent-but-pinging session outlives the idle timeout."""
    monkeypatch.setattr(settings, "STREAM_IDLE_TIMEOUT_S", 0.3)
    mock_get_model.return_value = make_model([("hi", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        for _ in range(6):  # 6 x 0.15 s = 0.9 s silent >> 0.3 s idle timeout
            time.sleep(0.15)
            ws.send_text(json.dumps({"type": "ping"}))
        # session must still be alive and functional
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "stop"}))
        types = []
        msg = ws.receive_json()
        while msg["type"] != "ack":
            types.append(msg["type"])
            msg = ws.receive_json()
        assert msg["of"] == "stop"
        assert "error" not in types


@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_ping_before_start_is_fatal(mock_get_model, _name):
    """C3.8: ping is legal only after start — as a first message it is a
    protocol violation (a v4.1 client never does this; C3.7 applies)."""
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        ws.send_text(json.dumps({"type": "ping"}))
        msg = ws.receive_json()
        assert msg["type"] == "error"
        assert msg["code"] == "protocol_violation"
        assert msg["fatal"] is True


# ---------------------------------------------------------------------------
# C2.5 — cumulative lead over real-time clamped at STREAM_BURST_CREDIT_S
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="m")
@patch("app.routes.stream_ws.get_model")
def test_ingest_burst_credit_clamped(mock_get_model, _name, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_BURST_CREDIT_S", 2.0)
    mock_get_model.return_value = make_model([])
    with connect() as ws:
        start_session(ws)
        # A ~0.9 s pre-roll style burst is legal…
        ws.send_bytes(pcm(0.9))
        # …but bulk replay far over real-time + credit is fatal (C2.5).
        with pytest.raises(WebSocketDisconnect):
            for _ in range(8):
                ws.send_bytes(pcm(0.5))
            # server closes after the violating frame; next receive surfaces it
            msg = ws.receive_json()
            while msg["type"] != "error":
                msg = ws.receive_json()
            assert msg["code"] == "protocol_violation"
            raise WebSocketDisconnect(1008)


# C7.12 — flush-seam duplicate: the flush window opens flush_left_context_s
# before the frontier; the residue of the LAST COMMITTED word re-decodes
# sentence-initial just past the frontier and must be suppressed (2026-08-02
# field finding: "very Very", one per VAD pause). C5.3 must still hold.
def test_flush_seam_duplicate_suppressed_c712():
    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)
        calls = {"n": 0}

        def transcribe(audio, **kwargs):
            calls["n"] += 1
            if calls["n"] <= 2:
                # tick decodes (window at 0): stable hypothesis; agreement
                # commits "very cool" (frontier = cool's end, 1.2 s)
                wl = [("very", 0.1, 0.5, 0.95), ("cool", 0.8, 1.2, 0.95),
                      ("stuff", 1.5, 1.9, 0.95)]
            else:
                # flush decode (window at frontier − 1.0 s = 0.2 s): the last
                # committed word's residue re-emits sentence-initial straddling
                # the frontier, then the genuine tail follows
                wl = [("Cool.", 0.95, 1.1, 0.9), ("stuff", 1.4, 1.75, 0.95)]
            words = [SimpleNamespace(word=f" {t}", start=st, end=e, probability=p)
                     for t, st, e, p in wl]
            return iter([SimpleNamespace(words=words, text="")]), SimpleNamespace(
                language="en", duration=len(audio) / 16000)

        s.model = SimpleNamespace(transcribe=transcribe)
        s.append_frame(pcm(2.0))
        await s._tick_once()  # records prev hypothesis
        await s._tick_once()  # agreement commits "very cool"
        await s.do_flush()

        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        committed = " ".join(p["text"] for p in payloads if p["type"] == "committed")
        assert committed == "very cool"
        final = [p for p in payloads if p["type"] == "final"][0]
        assert final["raw"] == "very cool stuff", (
            "frontier residue must be seam-suppressed, the genuine tail kept")
        assert final["raw"].startswith(committed)  # C5.3 untouched
        assert s.seam_suppressions == 1

    asyncio.run(run())


# C7.12 — the seam guard is bounded: a genuine immediate repeat starting past
# seam_tolerance_s survives the flush.
def test_flush_seam_genuine_repeat_past_tolerance_survives():
    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)
        calls = {"n": 0}

        def transcribe(audio, **kwargs):
            calls["n"] += 1
            if calls["n"] <= 2:
                wl = [("very", 0.1, 0.5, 0.95), ("cool", 0.8, 1.2, 0.95),
                      ("stuff", 1.5, 1.9, 0.95)]
            else:
                # repeat of the committed word spoken well after the frontier
                # (abs start 1.7 s > frontier 1.2 s + tolerance 0.1 s)
                wl = [("cool", 1.5, 1.7, 0.95), ("stuff", 1.75, 1.95, 0.95)]
            words = [SimpleNamespace(word=f" {t}", start=st, end=e, probability=p)
                     for t, st, e, p in wl]
            return iter([SimpleNamespace(words=words, text="")]), SimpleNamespace(
                language="en", duration=len(audio) / 16000)

        s.model = SimpleNamespace(transcribe=transcribe)
        s.append_frame(pcm(2.0))
        await s._tick_once()
        await s._tick_once()
        await s.do_flush()

        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        final = [p for p in payloads if p["type"] == "final"][0]
        assert final["raw"] == "very cool cool stuff", (
            "a genuine repeat outside the seam tolerance must never be eaten")
        assert s.seam_suppressions == 0

    asyncio.run(run())


# C7.12 — MIN_FLUSH_DECODE_S applies to the uncommitted tail, not the window:
# left context alone must never trigger a flush decode.
def test_flush_skips_decode_when_only_left_context_remains():
    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)
        calls = {"n": 0}

        def transcribe(audio, **kwargs):
            calls["n"] += 1
            wl = [("very", 0.1, 0.5, 0.95), ("cool", 0.8, 1.2, 0.95),
                  ("stuff", 1.4, 1.95, 0.95)]
            words = [SimpleNamespace(word=f" {t}", start=st, end=e, probability=p)
                     for t, st, e, p in wl]
            return iter([SimpleNamespace(words=words, text="")]), SimpleNamespace(
                language="en", duration=len(audio) / 16000)

        s.model = SimpleNamespace(transcribe=transcribe)
        # commit everything decodable, leaving < MIN_FLUSH_DECODE_S of tail:
        # frontier lands at 1.95 s of a 2.0 s buffer (50 ms tail)
        s.append_frame(pcm(2.0))
        await s._tick_once()
        await s._tick_once()  # commits "very cool" (edge guard holds "stuff")
        # force the frontier to the near-edge case directly: simulate the
        # ceiling flush arriving when only 50 ms is uncommitted
        s.policy = s.policy.__class__(
            committed_words=s.policy.committed_words,
            committed_through_sample=int(1.95 * s.sr),
            prev_hypothesis=s.policy.prev_hypothesis,
        )
        decode_calls_before = calls["n"]
        await s.do_flush()
        assert calls["n"] == decode_calls_before, (
            "flush must not decode when the uncommitted tail is below "
            "MIN_FLUSH_DECODE_S, even though the window now carries left context")
        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        final = [p for p in payloads if p["type"] == "final"][0]
        assert final["raw"] == "very cool"  # committed text only

    asyncio.run(run())


# C7.13 — tick-path residue: a re-decode that re-times the last committed
# word's end past the frontier must be suppressed in agree(), counted on the
# session, and absent from committed text.
def test_tick_residue_suppressed_and_counted_c713():
    async def run():
        ws = AsyncMock()
        s = StreamSession(ws)
        calls = {"n": 0}

        def transcribe(audio, **kwargs):
            calls["n"] += 1
            if calls["n"] <= 2:
                # stable hypothesis; tick 2 commits "very" (cool blocked by
                # edge guard at 2.0 s buffer: limit 1.4, cool ends 1.5)
                wl = [("very", 0.1, 1.0, 0.95), ("cool", 1.1, 1.5, 0.95),
                      ("stuff", 1.6, 1.9, 0.95)]
            else:
                # re-decode re-times "very"'s end 50 ms past the frontier
                wl = [("Very", 0.2, 1.05, 0.9), ("cool", 1.1, 1.5, 0.95),
                      ("stuff", 1.6, 2.0, 0.95), ("more", 2.1, 2.5, 0.95)]
            words = [SimpleNamespace(word=f" {t}", start=st, end=e, probability=p)
                     for t, st, e, p in wl]
            return iter([SimpleNamespace(words=words, text="")]), SimpleNamespace(
                language="en", duration=len(audio) / 16000)

        s.model = SimpleNamespace(transcribe=transcribe)
        s.append_frame(pcm(2.0))
        await s._tick_once()
        await s._tick_once()  # commits "very"
        s.append_frame(pcm(1.0))
        await s._tick_once()  # residue tick: "Very" suppressed, "cool" commits
        await s._tick_once()

        assert s.tick_residue_suppressions >= 1
        payloads = [c.args[0] for c in ws.send_json.call_args_list]
        committed = " ".join(p["text"] for p in payloads if p["type"] == "committed")
        words = committed.split()
        assert "Very" not in words, f"residue re-committed: {committed!r}"
        assert words.count("very") == 1, f"duplicate commit: {committed!r}"

    asyncio.run(run())


# ---------------------------------------------------------------------------
# C7.14 — decoder-edge token merge: glued fragments commit as whole words
# (2026-08-04 sign-off review: "K -fold" / "95 %" join artifacts)
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_glued_fragments_commit_as_whole_words(mock_get_model, _name):
    # Raw decoder surface: word-initial tokens carry the leading space,
    # glued continuations do not — the real faster-whisper shape, bypassing
    # make_model's uniform " {t}" wrapper on purpose.
    def transcribe(audio, **kwargs):
        words = [SimpleNamespace(word=t, start=s, end=e, probability=p)
                 for t, s, e, p in [(" K", 0.1, 0.2, 0.9), ("-fold", 0.2, 0.5, 0.8),
                                    (" cross", 0.6, 1.0, 0.9)]]
        segs = iter([SimpleNamespace(words=words, text="")])
        info = SimpleNamespace(language="en", duration=len(audio) / 16000)
        return segs, info
    m = MagicMock()
    m.transcribe.side_effect = transcribe
    mock_get_model.return_value = m
    with connect() as ws:
        start_session(ws)
        for _ in range(3):
            ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "flush"}))
        msg = ws.receive_json()
        while msg["type"] != "final":
            msg = ws.receive_json()
    assert "K-fold cross" in msg["raw"]
    assert "K -fold" not in msg["raw"]


# ---------------------------------------------------------------------------
# C9.3 — per-tick hypothesis trace (content-bearing, operator opt-in only)
# ---------------------------------------------------------------------------

@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_trace_disabled_by_default_writes_nothing(mock_get_model, _name, tmp_path, monkeypatch):
    # STREAM_TRACE_DIR is empty by default — a session must create no files
    # anywhere, even with a directory available to write into.
    assert settings.STREAM_TRACE_DIR == ""
    mock_get_model.return_value = make_model([("hi", 0.1, 0.3, 0.9)])
    with connect() as ws:
        start_session(ws)
        ws.send_bytes(pcm(0.5))
        ws.send_text(json.dumps({"type": "flush"}))
        while ws.receive_json()["type"] != "final":
            pass
    assert list(tmp_path.iterdir()) == []


@patch("app.routes.stream_ws.get_current_model_name", return_value="large-v3")
@patch("app.routes.stream_ws.get_model")
def test_trace_enabled_writes_header_tick_and_flush_records(
        mock_get_model, _name, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "STREAM_TRACE_DIR", str(tmp_path))
    mock_get_model.return_value = make_model([("hello", 0.1, 0.4, 0.9),
                                              ("world", 0.5, 0.9, 0.9)])
    with connect() as ws:
        start_session(ws)
        for _ in range(4):
            ws.send_bytes(pcm(0.5))
            time.sleep(0.05)  # let the 20 ms test tick fire between frames
        ws.send_text(json.dumps({"type": "flush"}))
        while ws.receive_json()["type"] != "final":
            pass
        ws.send_text(json.dumps({"type": "stop"}))
        while True:
            msg = ws.receive_json()
            if msg["type"] in ("ack", "final"):
                break
    files = list(tmp_path.glob("stream-trace-*.jsonl"))
    assert len(files) == 1
    records = [json.loads(line) for line in files[0].read_text().splitlines()]
    kinds = [r["kind"] for r in records]
    assert kinds[0] == "session"
    assert records[0]["trace_version"] == 1
    assert "transcript text" in records[0]["note"]
    assert records[0]["policy_config"]["max_holdback_ticks"] == settings.STREAM_MAX_HOLDBACK_TICKS
    assert "flush" in kinds
    flush_rec = next(r for r in records if r["kind"] == "flush")
    assert "hello world" in flush_rec["final_raw"]
    tick_recs = [r for r in records if r["kind"] == "tick"]
    if tick_recs:  # tick cadence is timing-dependent under test; shape-check when present
        t = tick_recs[0]
        for field in ("window_start_sample", "context_end_sample", "hyp",
                      "commit_n", "agreed_n", "eligible_n", "prev_compared"):
            assert field in t
