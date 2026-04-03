import io
import subprocess
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


def _make_audio_file(content: bytes = b"fake audio data", content_type: str = "audio/webm"):
    return ("file", ("test.webm", io.BytesIO(content), content_type))


def test_rejects_unsupported_mime_type():
    file = ("file", ("test.txt", io.BytesIO(b"not audio"), "text/plain"))
    response = client.post("/transcribe", files=[file])
    assert response.status_code == 400
    assert "Unsupported audio format" in response.json()["detail"]


def test_rejects_missing_file():
    response = client.post("/transcribe")
    assert response.status_code == 422


@patch("app.routes.transcribe.settings")
def test_rejects_oversized_file(mock_settings):
    mock_settings.max_upload_bytes = 10  # 10 bytes
    mock_settings.MAX_UPLOAD_MB = 0
    mock_settings.TEMP_DIR = "/tmp"
    content = b"x" * 100
    file = _make_audio_file(content=content)
    response = client.post("/transcribe", files=[file])
    assert response.status_code == 413
    assert "too large" in response.json()["detail"].lower()


def test_accepts_valid_mime_types():
    """Verify all accepted MIME types pass validation."""
    from app.routes.transcribe import validate_mime_type

    for mime in ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4"]:
        result = validate_mime_type(mime)
        assert result == mime


def test_rejects_invalid_mime_type():
    from app.routes.transcribe import validate_mime_type
    from fastapi import HTTPException
    import pytest

    with pytest.raises(HTTPException) as exc_info:
        validate_mime_type("video/mp4")
    assert exc_info.value.status_code == 400


def test_strips_codec_params_from_mime():
    from app.routes.transcribe import validate_mime_type

    result = validate_mime_type("audio/webm;codecs=opus")
    assert result == "audio/webm"


@patch("app.routes.transcribe.transcribe_audio")
@patch("app.routes.transcribe.get_wav_duration")
@patch("app.routes.transcribe.subprocess.run")
@patch("app.routes.transcribe.settings")
def test_transcribe_happy_path(mock_settings, mock_subprocess, mock_duration, mock_transcribe):
    mock_settings.max_upload_bytes = 10 * 1024 * 1024
    mock_settings.MAX_UPLOAD_MB = 10
    mock_settings.MAX_AUDIO_SECONDS = 60
    mock_settings.TEMP_DIR = "/tmp"
    mock_settings.DEVICE = "cpu"
    mock_settings.WHISPER_MODEL = "small"

    mock_subprocess.return_value = subprocess.CompletedProcess(args=[], returncode=0)
    mock_duration.return_value = 3.5
    mock_transcribe.return_value = {
        "text": "hello world",
        "language": "en",
        "duration": 3.5,
    }

    file = _make_audio_file()
    response = client.post("/transcribe", files=[file])
    assert response.status_code == 200

    data = response.json()
    assert data["raw"] == "hello world"
    assert data["cleaned"] == "Hello world"
    assert data["language"] == "en"
    assert data["duration"] == 3.5
    assert data["processing_mode"] == "cpu"
    assert data["model_name"] == "small"
