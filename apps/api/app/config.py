import os
import tempfile


class Settings:
    DEVICE: str = os.getenv("DEVICE", "cuda")
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "large-v3")
    WHISPER_AVAILABLE_MODELS: list[str] = [
        m.strip()
        for m in os.getenv("WHISPER_AVAILABLE_MODELS", os.getenv("WHISPER_MODEL", "large-v3")).split(",")
    ]
    MAX_AUDIO_SECONDS: int = int(os.getenv("MAX_AUDIO_SECONDS", "60"))
    MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "10"))
    # Host-friendly defaults for v3 sidecar operation. Docker Compose overrides
    # these via environment variables — no regression for `make dev`.
    MODEL_CACHE_DIR: str = os.getenv(
        "MODEL_CACHE_DIR",
        os.path.join(os.path.expanduser("~"), ".cache", "voice-scribe"),
    )
    TEMP_DIR: str = os.getenv(
        "TEMP_DIR",
        os.path.join(tempfile.gettempdir(), "voice-scribe"),
    )
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "info")
    API_PORT: int = int(os.getenv("API_PORT", "8084"))

    # Streaming path (/ws/stream) — limits and serving policy tunables.
    # docs/v4/protocol.md §6 and §7 are the authority on meanings and defaults.
    STREAM_PROTOCOL_VERSION: int = 1
    STREAM_SAMPLE_RATE: int = 16000
    STREAM_SAMPLE_FORMAT: str = "pcm_f32le"
    STREAM_MAX_FRAME_BYTES: int = int(os.getenv("STREAM_MAX_FRAME_BYTES", "65536"))
    STREAM_DECODE_TICK_MS: int = int(os.getenv("STREAM_DECODE_TICK_MS", "750"))
    STREAM_MIN_DECODE_S: float = float(os.getenv("STREAM_MIN_DECODE_S", "1.0"))
    STREAM_MAX_UNCOMMITTED_S: float = float(os.getenv("STREAM_MAX_UNCOMMITTED_S", "24.0"))
    STREAM_LEFT_CONTEXT_S: float = float(os.getenv("STREAM_LEFT_CONTEXT_S", "3.0"))
    STREAM_WORD_PROB_FLOOR: float = float(os.getenv("STREAM_WORD_PROB_FLOOR", "0.5"))
    STREAM_EDGE_GUARD_S: float = float(os.getenv("STREAM_EDGE_GUARD_S", "0.6"))
    STREAM_MAX_HOLDBACK_TICKS: int = int(os.getenv("STREAM_MAX_HOLDBACK_TICKS", "6"))
    STREAM_MAX_UTTERANCE_S: float = float(os.getenv("STREAM_MAX_UTTERANCE_S", "120"))
    STREAM_MAX_SESSION_S: float = float(os.getenv("STREAM_MAX_SESSION_S", "1800"))
    STREAM_IDLE_TIMEOUT_S: float = float(os.getenv("STREAM_IDLE_TIMEOUT_S", "10"))
    STREAM_BURST_CREDIT_S: float = float(os.getenv("STREAM_BURST_CREDIT_S", "10"))
    STREAM_PREEMPT_GRACE_S: float = float(os.getenv("STREAM_PREEMPT_GRACE_S", "2.0"))

    @property
    def cors_origins(self) -> list[str]:
        # Tauri v2 origin: https://tauri.localhost (Windows) or tauri://localhost (Linux).
        # Both included so WebSocket origin checks don't silently reject with 4003.
        raw = os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5174,http://127.0.0.1:5174,https://tauri.localhost,tauri://localhost",
        )
        return [origin.strip() for origin in raw.split(",")]

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def compute_type(self) -> str:
        return "float16" if self.DEVICE == "cuda" else "int8"


settings = Settings()
