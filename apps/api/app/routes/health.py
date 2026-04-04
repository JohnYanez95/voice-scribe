from fastapi import APIRouter

from app.config import settings
from app.schemas import HealthResponse
from app.services.transcription import get_current_model_name, is_model_loaded

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=is_model_loaded(),
        device=settings.DEVICE,
        model_name=get_current_model_name() or settings.WHISPER_MODEL,
    )
