import gc
import threading
import time
from pathlib import Path

import structlog
from faster_whisper import WhisperModel

from app.config import Settings

log = structlog.get_logger()

_model: WhisperModel | None = None
_model_lock = threading.Lock()
_current_model_name: str | None = None

AVAILABLE_MODELS: list[str] = []


def load_model(config: Settings) -> None:
    global _model, _current_model_name, AVAILABLE_MODELS
    AVAILABLE_MODELS = config.WHISPER_AVAILABLE_MODELS

    log.info("model download started", model=config.WHISPER_MODEL, device=config.DEVICE)
    start = time.monotonic()

    with _model_lock:
        _model = WhisperModel(
            config.WHISPER_MODEL,
            device=config.DEVICE,
            compute_type=config.compute_type,
            download_root=config.MODEL_CACHE_DIR,
        )
        _current_model_name = config.WHISPER_MODEL

    elapsed = time.monotonic() - start
    log.info("model download complete", duration=f"{elapsed:.1f}s", model=config.WHISPER_MODEL)


def get_model() -> WhisperModel:
    with _model_lock:
        model = _model
    if model is None:
        raise RuntimeError("Model not loaded — call load_model() first")
    return model


def is_model_loaded() -> bool:
    return _model is not None


def get_current_model_name() -> str | None:
    return _current_model_name


def swap_model(model_name: str, config: Settings) -> dict:
    """Swap the loaded model. Thread-safe. Returns status dict with timing."""
    global _model, _current_model_name

    old_name = _current_model_name

    log.info("model swap started", previous_model=old_name, new_model=model_name)
    start = time.monotonic()

    with _model_lock:
        new_model = WhisperModel(
            model_name,
            device=config.DEVICE,
            compute_type=config.compute_type,
            download_root=config.MODEL_CACHE_DIR,
        )

        old_model = _model
        _model = new_model
        _current_model_name = model_name

    # Free old model VRAM outside the lock
    del old_model
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass

    elapsed = time.monotonic() - start
    log.info("model swap complete", duration=f"{elapsed:.1f}s", model=model_name)

    return {
        "previous_model": old_name,
        "current_model": model_name,
        "duration": elapsed,
    }


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
