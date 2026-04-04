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


class ModelInfo(BaseModel):
    name: str
    is_current: bool


class ModelListResponse(BaseModel):
    models: list[ModelInfo]
    current_model: str


class ModelSwapRequest(BaseModel):
    model_name: str


class ModelSwapResponse(BaseModel):
    previous_model: str
    current_model: str
    swap_duration: float
