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
    API_PORT: int = int(os.getenv("API_PORT", "8000"))

    @property
    def cors_origins(self) -> list[str]:
        # Tauri v2 origin: https://tauri.localhost (Windows) or tauri://localhost (Linux).
        # Both included so WebSocket origin checks don't silently reject with 4003.
        raw = os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,https://tauri.localhost,tauri://localhost",
        )
        return [origin.strip() for origin in raw.split(",")]

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def compute_type(self) -> str:
        return "float16" if self.DEVICE == "cuda" else "int8"


settings = Settings()
