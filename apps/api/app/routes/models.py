import structlog
from fastapi import APIRouter, HTTPException

from app.config import settings
from app.schemas import (
    ErrorResponse,
    ModelInfo,
    ModelListResponse,
    ModelSwapRequest,
    ModelSwapResponse,
)
from app.services import stream_guard, transcription
from app.services.transcription import (
    get_current_model_name,
    swap_model,
)

log = structlog.get_logger()

router = APIRouter()


@router.get("/models", response_model=ModelListResponse)
def list_models() -> ModelListResponse:
    current = get_current_model_name()
    return ModelListResponse(
        models=[ModelInfo(name=m, is_current=(m == current)) for m in transcription.AVAILABLE_MODELS],
        current_model=current or "",
    )


@router.post(
    "/models/swap",
    response_model=ModelSwapResponse,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
def swap_model_route(request: ModelSwapRequest) -> ModelSwapResponse:
    if request.model_name not in transcription.AVAILABLE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{request.model_name}' not available. Options: {', '.join(transcription.AVAILABLE_MODELS)}",
        )

    current = get_current_model_name()
    if request.model_name == current:
        return ModelSwapResponse(
            previous_model=current or "",
            current_model=current or "",
            swap_duration=0.0,
        )

    # Swap and stream are mutually exclusive under a single guard (protocol
    # C8.1): a streaming session holds its model reference for the session's
    # lifetime, so a mid-stream swap means double VRAM for minutes. The flag
    # stays set for the swap's full duration (model download included) so a
    # stream cannot start mid-download and block on get_model().
    if not stream_guard.try_begin_swap():
        raise HTTPException(
            status_code=409,
            detail="A streaming session is active. Stop the stream before swapping models.",
        )
    try:
        result = swap_model(request.model_name, settings)
    except Exception as e:
        log.error("model swap failed", error=str(e))
        raise HTTPException(status_code=500, detail="Model swap failed")
    finally:
        stream_guard.end_swap()

    return ModelSwapResponse(
        previous_model=result["previous_model"] or "",
        current_model=result["current_model"],
        swap_duration=result["duration"],
    )
