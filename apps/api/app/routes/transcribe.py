import os
import subprocess
import tempfile
import time

import structlog
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.config import settings
from app.schemas import ErrorResponse, TranscribeResponse
from app.services.cleanup import clean_transcript
from app.services.transcription import transcribe_audio

log = structlog.get_logger()

router = APIRouter()

ALLOWED_MIME_TYPES = {
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/mpeg",
}

MIME_TO_SUFFIX = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
}


def validate_mime_type(content_type: str | None) -> str:
    """Validate the MIME type of an uploaded file.

    Returns the validated MIME type. Structured so that adding
    magic-byte checking is a one-line addition.
    """
    if not content_type:
        raise HTTPException(status_code=400, detail="Missing Content-Type header")

    # Normalize: strip parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm")
    mime = content_type.split(";")[0].strip().lower()

    if mime not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format: {mime}. Accepted: {', '.join(sorted(ALLOWED_MIME_TYPES))}",
        )

    return mime


def get_wav_duration(wav_path: str) -> float:
    """Get duration of a WAV file using ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            wav_path,
        ],
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


@router.post(
    "/transcribe",
    response_model=TranscribeResponse,
    responses={400: {"model": ErrorResponse}, 413: {"model": ErrorResponse}},
)
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> TranscribeResponse:
    # Validate MIME type
    mime = validate_mime_type(file.content_type)

    # Read and check size
    content = await file.read()
    if len(content) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size: {settings.MAX_UPLOAD_MB} MB",
        )

    suffix = MIME_TO_SUFFIX.get(mime, ".webm")
    tmp_input = None
    tmp_wav = None

    try:
        # Write uploaded content to temp file
        tmp_input = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, dir=settings.TEMP_DIR
        )
        tmp_input.write(content)
        tmp_input.flush()
        tmp_input.close()

        # Transcode to 16kHz mono WAV
        tmp_wav = tempfile.NamedTemporaryFile(
            delete=False, suffix=".wav", dir=settings.TEMP_DIR
        )
        tmp_wav.close()

        log.info("transcode started", input_format=mime)
        transcode_start = time.monotonic()

        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", tmp_input.name,
                    "-ar", "16000",
                    "-ac", "1",
                    "-f", "wav",
                    tmp_wav.name,
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
        except subprocess.CalledProcessError as e:
            log.error("transcode failed", stderr=e.stderr)
            raise HTTPException(status_code=500, detail="Audio transcoding failed")

        transcode_elapsed = time.monotonic() - transcode_start
        log.info("transcode complete", output="16kHz mono WAV", duration=f"{transcode_elapsed:.1f}s")

        # Check duration
        duration = get_wav_duration(tmp_wav.name)
        if duration > settings.MAX_AUDIO_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"Audio too long ({duration:.0f}s). Maximum: {settings.MAX_AUDIO_SECONDS}s",
            )

        # Transcribe
        try:
            result = transcribe_audio(tmp_wav.name, language=language)
        except Exception as e:
            log.error("transcription failed", error=str(e))
            raise HTTPException(status_code=500, detail="Transcription failed")

        raw_text = result["text"]
        return TranscribeResponse(
            raw=raw_text,
            cleaned=clean_transcript(raw_text),
            language=result["language"],
            duration=result["duration"],
            processing_mode=settings.DEVICE,
            model_name=settings.WHISPER_MODEL,
        )

    finally:
        for f in [tmp_input, tmp_wav]:
            if f is not None:
                try:
                    os.unlink(f.name)
                except OSError:
                    pass
