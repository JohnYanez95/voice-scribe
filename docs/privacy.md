# Privacy

Voice Scribe is designed as a local-only tool. Audio and transcripts never leave your machine.

## Data flow

1. **Audio recording**: Captured by the browser via `MediaRecorder`. The audio blob exists in browser memory only.
2. **Upload**: Sent over `localhost` HTTP to the API container. Never touches a network interface beyond loopback.
3. **Temp storage**: Written to a temp file inside the container for transcoding. Deleted immediately after transcription in a `finally` block.
4. **Transcription**: Performed locally by faster-whisper. No cloud API calls.
5. **Transcript**: Returned to the browser over localhost. Displayed in an editable textarea. Not persisted server-side.

## What is not logged

- Raw audio content
- Transcript text
- Any content derived from the user's speech

## What is logged

Operational telemetry only:
- Model download start/complete with duration
- Transcode start/complete with input format and duration
- Inference start/complete with duration and detected language
- HTTP request status codes

## What is stored

- **Model weights** (`data/cache/`): Downloaded from HuggingFace on first run. These are public model files, not user data.
- **Temp files** (`data/tmp/`): Transient audio files deleted after each request. Should be empty when idle.

## Network exposure

The API binds to `localhost:8000`. It is not accessible from other machines on the network. CORS is restricted to `localhost:5173` and `127.0.0.1:5173`.
