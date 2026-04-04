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
from app.services.transcription import (
    AVAILABLE_MODELS,
    get_current_model_name,
    swap_model,
)

log = structlog.get_logger()

router = APIRouter()


@router.get("/models", response_model=ModelListResponse)
def list_models() -> ModelListResponse:
    current = get_current_model_name()
    return ModelListResponse(
        models=[ModelInfo(name=m, is_current=(m == current)) for m in AVAILABLE_MODELS],
        current_model=current or "",
    )


@router.post(
    "/models/swap",
    response_model=ModelSwapResponse,
    responses={400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
def swap_model_route(request: ModelSwapRequest) -> ModelSwapResponse:
    if request.model_name not in AVAILABLE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{request.model_name}' not available. Options: {', '.join(AVAILABLE_MODELS)}",
        )

    current = get_current_model_name()
    if request.model_name == current:
        return ModelSwapResponse(
            previous_model=current or "",
            current_model=current or "",
            swap_duration=0.0,
        )

    try:
        result = swap_model(request.model_name, settings)
    except Exception as e:
        log.error("model swap failed", error=str(e))
        raise HTTPException(status_code=500, detail="Model swap failed")

    return ModelSwapResponse(
        previous_model=result["previous_model"] or "",
        current_model=result["current_model"],
        swap_duration=result["duration"],
    )
