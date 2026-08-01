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
        words = [SimpleNamespace(word=t, start=s, end=e, probability=p)
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
        assert msg["utterance_id"] == 0

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
