import io
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
