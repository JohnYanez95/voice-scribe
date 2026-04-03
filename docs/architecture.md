# Architecture

## Overview

Voice Scribe is a two-service system: a browser frontend and a containerized API backend.

```
[Browser UI on host]
    ├─ record audio (MediaRecorder, webm/opus)
    ├─ show editable transcript
    └─ copy final text
            │  HTTP (localhost)
            ▼
[Local API in Docker container]
    ├─ GET  /health
    └─ POST /transcribe
            │
            ▼
[faster-whisper + ffmpeg runtime]
```

## Frontend (apps/web)

React + TypeScript + Vite running on the host at `localhost:5173`.

- **Recorder**: Uses `MediaRecorder` with `audio/webm;codecs=opus`. Falls back with a clear error if the codec is unsupported.
- **Transcript**: Editable textarea with clipboard copy.
- **API service**: Plain `fetch()` calls to `localhost:8000`. No proxy, no WebSocket.

## Backend (apps/api)

FastAPI running in a Docker container at `localhost:8000`.

- **POST /transcribe**: Accepts multipart audio upload, validates MIME type, transcodes to 16kHz mono WAV via ffmpeg, runs inference via faster-whisper, returns transcript text.
- **GET /health**: Returns service status, device mode, model info.
- **Transcription service**: Loads faster-whisper model on startup, holds it in memory for the lifetime of the process.

## Request lifecycle

1. Browser records audio blob (webm/opus)
2. Frontend POSTs blob to `/transcribe` as multipart/form-data
3. Backend validates MIME type and file size
4. Backend writes blob to temp file, transcodes with ffmpeg to 16kHz mono WAV
5. Backend runs faster-whisper inference on the WAV
6. Backend deletes both temp files in a `finally` block
7. Backend returns transcript text, language, and duration
8. Frontend displays transcript in editable textarea

## Key design decisions

- **Synchronous inference**: faster-whisper blocks the thread. Acceptable for single-user local use. Future rework path: `asyncio.to_thread()` or background task with polling.
- **Server-side transcoding**: The browser produces webm/opus; ffmpeg normalizes it. This keeps the frontend simple and handles format variation.
- **No reverse proxy**: Direct HTTP between frontend and backend on localhost. CORS middleware handles cross-origin.
- **Model weights outside container**: Downloaded on first run to a host-mounted volume (`data/cache/`). Survives container rebuilds.
