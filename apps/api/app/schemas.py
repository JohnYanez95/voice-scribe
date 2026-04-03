from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    device: str
    model_name: str


class TranscribeResponse(BaseModel):
    raw: str
    cleaned: str
    language: str
    duration: float
    processing_mode: str
    model_name: str


class ErrorResponse(BaseModel):
    detail: str
