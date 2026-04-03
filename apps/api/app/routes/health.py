from fastapi import APIRouter

from app.config import settings
from app.schemas import HealthResponse
from app.services.transcription import is_model_loaded

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=is_model_loaded(),
        device=settings.DEVICE,
        model_name=settings.WHISPER_MODEL,
    )
