from typing import Literal

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


# WebSocket message schemas
# Wire format is plain dicts; these document the protocol contract.

class WsSegmentMessage(BaseModel):
    type: Literal["segment"]
    text: str


class WsCompleteMessage(BaseModel):
    type: Literal["complete"]
    raw: str
    cleaned: str
    language: str
    duration: float
    model_name: str
    processing_mode: str


class WsErrorMessage(BaseModel):
    type: Literal["error"]
    detail: str


# Streaming protocol messages (/ws/stream) — docs/v4/protocol.md, version 1.
# All server → client messages carry seq (monotonic per session); messages
# scoped to an utterance also carry utterance_id.

StreamErrorCode = Literal[
    "busy",
    "preempted",
    "protocol_violation",
    "frame_too_large",
    "unsupported_format",
    "unsupported_version",
    "model_swapping",
    "decode_failure",
    "overrun",
    "session_timeout",
]


class WsStreamStartMessage(BaseModel):
    """Client → server session open (protocol C3.1)."""
    type: Literal["start"]
    protocol_version: int
    sample_format: str
    sample_rate: int
    language: str | None = None


class WsStreamReadyMessage(BaseModel):
    """Handshake echo (C4.1). Client must not send frames before this."""
    type: Literal["ready"]
    seq: int
    protocol_version: int
    session_id: str
    sample_rate: int
    sample_format: str
    max_frame_bytes: int
    model_name: str
    language: str | None
    decode_tick_ms: int
    max_uncommitted_s: float
    max_holdback_ticks: int


class WsStreamPartialMessage(BaseModel):
    """Tentative tail (C4.2). text REPLACES the entire tentative tail. Never
    persist, copy, transform, or act on partial text."""
    type: Literal["partial"]
    seq: int
    utterance_id: int
    text: str


class WsStreamCommittedMessage(BaseModel):
    """Append-only delta (C4.3). t0/t1 are received-audio seconds within the
    utterance — not wall clock."""
    type: Literal["committed"]
    seq: int
    utterance_id: int
    text: str
    t0: float
    t1: float


class WsStreamFinalMessage(BaseModel):
    """Utterance flush (C4.4). raw carries the utterance's committed text as a
    literal prefix. duration is received-audio seconds from frame count."""
    type: Literal["final"]
    seq: int
    utterance_id: int
    raw: str
    cleaned: str
    language: str
    duration: float
    model_name: str
    processing_mode: str
    dropped_audio_ms: float
    forced: bool


class WsStreamErrorMessage(BaseModel):
    """code is the stable machine-readable surface (C4.5); detail is unstable.
    fatal=true → session over, degrade per protocol §10."""
    type: Literal["error"]
    seq: int
    code: StreamErrorCode
    detail: str
    fatal: bool


class WsStreamAckMessage(BaseModel):
    """Ack for stop/reset (C4.6)."""
    type: Literal["ack"]
    seq: int
    of: Literal["stop", "reset"]
    utterance_id: int
    frames_dropped_after_stop: int | None = None
