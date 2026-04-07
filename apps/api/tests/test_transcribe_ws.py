import subprocess
import threading
from unittest.mock import MagicMock, patch

import pytest
from starlette.websockets import WebSocketDisconnect
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)

ALLOWED_ORIGIN = "http://localhost:5174"
ALLOWED_HEADERS = {"origin": ALLOWED_ORIGIN}


def _settings(**overrides):
    s = MagicMock()
    s.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    s.max_upload_bytes = 10 * 1024 * 1024
    s.MAX_UPLOAD_MB = 10
    s.TEMP_DIR = "/tmp"
    s.DEVICE = "cpu"
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def _model(texts=None):
    if texts is None:
        texts = [" Hello world", " This is a test"]
    segments = [MagicMock(text=t) for t in texts]
    info = MagicMock(language="en", duration=3.5)
    m = MagicMock()
    m.transcribe.return_value = (iter(segments), info)
    return m


# ---------------------------------------------------------------------------
# Happy path — segments stream, complete message arrives
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.get_current_model_name", return_value="small")
@patch("app.routes.transcribe_ws.get_model")
@patch("app.routes.transcribe_ws.subprocess.run")
@patch("app.routes.transcribe_ws.settings")
def test_ws_happy_path(mock_settings, mock_subprocess, mock_get_model, mock_get_name):
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10
    mock_settings.TEMP_DIR = "/tmp"
    mock_settings.DEVICE = "cpu"
    mock_subprocess.return_value = subprocess.CompletedProcess(args=[], returncode=0)
    mock_get_model.return_value = _model()

    with client.websocket_connect("/ws/transcribe", headers=ALLOWED_HEADERS) as ws:
        ws.send_bytes(b"fake audio data")
        messages = []
        while True:
            msg = ws.receive_json()
            messages.append(msg)
            if msg["type"] in ("complete", "error"):
                break

    types = [m["type"] for m in messages]
    assert "segment" in types
    assert types[-1] == "complete"

    complete = messages[-1]
    assert complete["language"] == "en"
    assert complete["duration"] == 3.5
    assert complete["model_name"] == "small"
    assert complete["processing_mode"] == "cpu"
    assert "Hello world" in complete["raw"]
    # Cleaned transcript should be capitalized
    assert complete["cleaned"][0].isupper()


# ---------------------------------------------------------------------------
# Disallowed origin — server closes with 4003 before accept
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.settings")
def test_ws_rejects_disallowed_origin(mock_settings):
    mock_settings.cors_origins = ["http://localhost:5174"]

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(
            "/ws/transcribe",
            headers={"origin": "http://evil.example.com"},
        ):
            pass  # Never reached — exception raised in __enter__

    assert exc_info.value.code == 4003


# ---------------------------------------------------------------------------
# Oversized payload — error message returned, then connection closes
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.settings")
def test_ws_oversized_payload(mock_settings):
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10  # 10 bytes — any real payload will exceed this
    mock_settings.MAX_UPLOAD_MB = 0

    with client.websocket_connect("/ws/transcribe", headers=ALLOWED_HEADERS) as ws:
        ws.send_bytes(b"x" * 100)
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "too large" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# Inference failure — error message returned, temp files cleaned up
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.get_model")
@patch("app.routes.transcribe_ws.subprocess.run")
@patch("app.routes.transcribe_ws.settings")
def test_ws_inference_failure(mock_settings, mock_subprocess, mock_get_model):
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10
    mock_settings.TEMP_DIR = "/tmp"
    mock_settings.DEVICE = "cpu"
    mock_subprocess.return_value = subprocess.CompletedProcess(args=[], returncode=0)

    bad_model = MagicMock()
    bad_model.transcribe.side_effect = RuntimeError("inference exploded")
    mock_get_model.return_value = bad_model

    with client.websocket_connect("/ws/transcribe", headers=ALLOWED_HEADERS) as ws:
        ws.send_bytes(b"fake audio data")
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "transcription" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# audio_format query parameter — correct temp file suffix
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.get_current_model_name", return_value="small")
@patch("app.routes.transcribe_ws.get_model")
@patch("app.routes.transcribe_ws.subprocess.run")
@patch("app.routes.transcribe_ws.settings")
def test_ws_ogg_format_uses_ogg_suffix(mock_settings, mock_subprocess, mock_get_model, mock_get_name):
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10
    mock_settings.TEMP_DIR = "/tmp"
    mock_settings.DEVICE = "cpu"
    mock_subprocess.return_value = subprocess.CompletedProcess(args=[], returncode=0)
    mock_get_model.return_value = _model()

    with client.websocket_connect(
        "/ws/transcribe?audio_format=audio/ogg", headers=ALLOWED_HEADERS
    ) as ws:
        ws.send_bytes(b"fake audio data")
        messages = []
        while True:
            msg = ws.receive_json()
            messages.append(msg)
            if msg["type"] in ("complete", "error"):
                break

    # The ffmpeg -i arg should reference a .ogg temp file
    call_args = mock_subprocess.call_args[0][0]
    input_path = call_args[call_args.index("-i") + 1]
    assert input_path.endswith(".ogg"), f"Expected .ogg suffix, got: {input_path}"
    assert messages[-1]["type"] == "complete"


@patch("app.routes.transcribe_ws.get_current_model_name", return_value="small")
@patch("app.routes.transcribe_ws.get_model")
@patch("app.routes.transcribe_ws.subprocess.run")
@patch("app.routes.transcribe_ws.settings")
def test_ws_unknown_format_uses_no_extension(mock_settings, mock_subprocess, mock_get_model, mock_get_name):
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10
    mock_settings.TEMP_DIR = "/tmp"
    mock_settings.DEVICE = "cpu"
    mock_subprocess.return_value = subprocess.CompletedProcess(args=[], returncode=0)
    mock_get_model.return_value = _model()

    with client.websocket_connect(
        "/ws/transcribe?audio_format=audio/unknown", headers=ALLOWED_HEADERS
    ) as ws:
        ws.send_bytes(b"fake audio data")
        messages = []
        while True:
            msg = ws.receive_json()
            messages.append(msg)
            if msg["type"] in ("complete", "error"):
                break

    call_args = mock_subprocess.call_args[0][0]
    input_path = call_args[call_args.index("-i") + 1]
    assert not input_path.endswith((".webm", ".ogg", ".wav", ".mp4", ".mp3")), \
        f"Expected no audio extension for unknown format, got: {input_path}"


# ---------------------------------------------------------------------------
# Empty payload — 0-byte audio rejected immediately
# ---------------------------------------------------------------------------

@patch("app.routes.transcribe_ws.settings")
def test_ws_empty_payload_rejected(mock_settings):
    """Server sends error immediately for 0-byte audio instead of crashing ffmpeg."""
    mock_settings.cors_origins = [ALLOWED_ORIGIN, "http://127.0.0.1:5174"]
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10

    with client.websocket_connect("/ws/transcribe", headers=ALLOWED_HEADERS) as ws:
        ws.send_bytes(b"")
        msg = ws.receive_json()

    assert msg["type"] == "error"
    assert "no audio data" in msg["detail"].lower()


# ---------------------------------------------------------------------------
# Concurrency contract — swap_model() during active streaming inference
#
# The inference thread holds a strong local reference to the model via
# get_model(). swap_model() replaces _model and calls del old_model, but
# Python's refcount keeps the old model alive until the inference thread
# releases its reference. Both operations must complete without error.
# ---------------------------------------------------------------------------

@patch("app.services.transcription.WhisperModel")
def test_swap_during_active_streaming_inference(mock_whisper_cls):
    import queue as stdlib_queue
    from app.services import transcription as trans_module

    # Gates to control segment yield timing
    segment_gate = threading.Event()
    inference_started = threading.Event()

    def slow_segments():
        inference_started.set()
        yield MagicMock(text=" first")
        segment_gate.wait(timeout=5)  # Hold until swap completes
        yield MagicMock(text=" second")

    info = MagicMock(language="en", duration=2.0)
    old_model = MagicMock()
    old_model.transcribe.return_value = (slow_segments(), info)

    new_model = MagicMock()
    mock_whisper_cls.return_value = new_model

    # Inject old model
    original_model = trans_module._model
    original_name = trans_module._current_model_name
    trans_module._model = old_model
    trans_module._current_model_name = "old-model"

    result_queue: stdlib_queue.Queue = stdlib_queue.Queue()

    def run_inference():
        # Mirrors the contract in run_inference() inside ws_transcribe:
        # hold a strong local reference through the full segment iteration.
        model_ref = trans_module.get_model()
        segs, _ = model_ref.transcribe("fake.wav")
        texts = [seg.text.strip() for seg in segs]
        result_queue.put(texts)

    t = threading.Thread(target=run_inference)
    t.start()

    # Wait for inference to begin, then swap mid-iteration
    assert inference_started.wait(timeout=2), "Inference thread did not start"

    swap_config = MagicMock(DEVICE="cpu", compute_type="int8", MODEL_CACHE_DIR="/cache")
    swap_result = trans_module.swap_model("new-model", swap_config)

    # Unblock the second segment
    segment_gate.set()

    t.join(timeout=5)
    assert not t.is_alive(), "Inference thread did not complete"

    texts = result_queue.get_nowait()
    assert texts == ["first", "second"], "All segments should have been yielded"
    assert swap_result["current_model"] == "new-model"
    assert trans_module._current_model_name == "new-model"

    # Restore module state
    trans_module._model = original_model
    trans_module._current_model_name = original_name
