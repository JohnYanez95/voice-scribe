import asyncio
import os
import subprocess
import tempfile
import threading
import time

import structlog
from fastapi import APIRouter
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.config import settings
from app.services.cleanup import clean_transcript
from app.services.transcription import get_current_model_name, get_model

log = structlog.get_logger()

router = APIRouter()

_MIME_TO_SUFFIX: dict[str, str] = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
}


@router.websocket("/ws/transcribe")
async def ws_transcribe(
    websocket: WebSocket,
    language: str | None = None,
    audio_format: str | None = None,
) -> None:
    """Stream transcription segments over WebSocket.

    Protocol:
      Client → Server: binary audio blob (format negotiated by MediaRecorder)
      Server → Client: JSON messages
        {"type": "segment", "text": "..."}     — one per faster-whisper segment
        {"type": "complete", "raw": "...", "cleaned": "...", "language": "...",
         "duration": ..., "model_name": "...", "processing_mode": "..."}
        {"type": "error", "detail": "..."}     — on any failure

    The audio_format query parameter tells the server which container the
    client used (e.g. "audio/ogg"). Defaults to "audio/webm" for backward
    compatibility. ffmpeg probes magic bytes regardless, but the correct
    suffix improves log clarity and debugging.
    """
    # Origin enforcement — FastAPI CORSMiddleware does not cover WebSocket.
    origin = websocket.headers.get("origin", "")
    if origin not in settings.cors_origins:
        log.warning("ws_transcribe: rejected disallowed origin", origin=origin)
        await websocket.close(code=4003)
        return

    await websocket.accept()

    tmp_input = None
    tmp_wav = None

    try:
        # Receive audio blob
        audio_data = await websocket.receive_bytes()

        # Size validation
        if len(audio_data) > settings.max_upload_bytes:
            await websocket.send_json({
                "type": "error",
                "detail": f"File too large. Maximum size: {settings.MAX_UPLOAD_MB} MB",
            })
            return

        # Write to temp input file (no extension when format unknown — lets
        # ffmpeg probe content instead of being misled by a wrong suffix)
        suffix = _MIME_TO_SUFFIX.get(audio_format, "") if audio_format else ""
        tmp_input = tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, dir=settings.TEMP_DIR
        )
        tmp_input.write(audio_data)
        tmp_input.flush()
        tmp_input.close()

        # Transcode to 16kHz mono WAV (non-blocking)
        tmp_wav = tempfile.NamedTemporaryFile(
            delete=False, suffix=".wav", dir=settings.TEMP_DIR
        )
        tmp_wav.close()

        log.info("ws transcode started", input_format=audio_format or "audio/webm")
        transcode_start = time.monotonic()

        try:
            await asyncio.to_thread(
                subprocess.run,
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
            log.error("ws transcode failed", stderr=e.stderr)
            await websocket.send_json({"type": "error", "detail": "Audio transcoding failed"})
            return

        log.info(
            "ws transcode complete",
            output="16kHz mono WAV",
            duration=f"{time.monotonic() - transcode_start:.1f}s",
        )

        wav_path = tmp_wav.name

        # Stream inference segments via thread + async queue.
        # Concurrency contract: run_inference holds a strong reference to the
        # model via get_model(). If swap_model() fires concurrently, it replaces
        # _model but cannot free the old model while this thread's local `model`
        # reference is alive. VRAM cleanup is deferred until inference completes.
        # See: transcription.py swap_model() comment.
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()
        cancel_event = threading.Event()

        def run_inference() -> None:
            # Hold a strong local reference to the model for the full duration
            # of segment iteration. This prevents swap_model()'s del old_model
            # from affecting a mid-yield inference — see concurrency contract.
            model = get_model()
            current_name = get_current_model_name() or ""  # Capture before any swap interleaves
            try:
                log.info("ws inference started", wav_path=wav_path)
                inf_start = time.monotonic()

                kwargs: dict = {"beam_size": 5, "vad_filter": True}
                if language:
                    kwargs["language"] = language

                segments, info = model.transcribe(wav_path, **kwargs)

                all_texts: list[str] = []
                for seg in segments:
                    if cancel_event.is_set():
                        break
                    text = seg.text.strip()
                    if text:
                        all_texts.append(text)
                        loop.call_soon_threadsafe(
                            queue.put_nowait,
                            {"type": "segment", "text": text},
                        )

                elapsed = time.monotonic() - inf_start
                log.info("ws inference complete", duration=f"{elapsed:.1f}s", language=info.language)

                raw = " ".join(all_texts)
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    {
                        "type": "complete",
                        "raw": raw,
                        "cleaned": clean_transcript(raw),
                        "language": info.language,
                        "duration": info.duration,
                        "model_name": current_name,
                        "processing_mode": settings.DEVICE,
                    },
                )
            except Exception as e:
                log.error("ws inference failed", error=str(e))
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    {"type": "error", "detail": "Transcription failed"},
                )
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

        threading.Thread(target=run_inference, daemon=True).start()

        try:
            while True:
                msg = await queue.get()
                if msg is None:
                    break
                await websocket.send_json(msg)
        except WebSocketDisconnect:
            log.info("ws client disconnected mid-stream")
            cancel_event.set()

    except WebSocketDisconnect:
        log.info("ws client disconnected before audio received")
    finally:
        for f in [tmp_input, tmp_wav]:
            if f is not None:
                try:
                    os.unlink(f.name)
                except OSError:
                    pass
