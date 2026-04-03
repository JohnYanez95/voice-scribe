import time
from pathlib import Path

import structlog
from faster_whisper import WhisperModel

from app.config import Settings

log = structlog.get_logger()

_model: WhisperModel | None = None


def load_model(config: Settings) -> None:
    global _model
    log.info("model download started", model=config.WHISPER_MODEL, device=config.DEVICE)
    start = time.monotonic()

    _model = WhisperModel(
        config.WHISPER_MODEL,
        device=config.DEVICE,
        compute_type=config.compute_type,
        download_root=config.MODEL_CACHE_DIR,
    )

    elapsed = time.monotonic() - start
    log.info("model download complete", duration=f"{elapsed:.1f}s", model=config.WHISPER_MODEL)


def get_model() -> WhisperModel:
    if _model is None:
        raise RuntimeError("Model not loaded — call load_model() first")
    return _model


def is_model_loaded() -> bool:
    return _model is not None


def transcribe_audio(audio_path: Path, language: str | None = None) -> dict:
    model = get_model()

    log.info("inference started", audio_path=str(audio_path))
    start = time.monotonic()

    kwargs: dict = {"beam_size": 5}
    if language:
        kwargs["language"] = language

    segments, info = model.transcribe(str(audio_path), vad_filter=True, **kwargs)
    text = " ".join(segment.text.strip() for segment in segments)

    elapsed = time.monotonic() - start
    log.info("inference complete", duration=f"{elapsed:.1f}s", language=info.language)

    return {
        "text": text,
        "language": info.language,
        "duration": info.duration,
    }
