# Privacy

Voice Scribe is designed as a local-only tool. Audio and transcripts never leave your machine.

## Data flow

1. **Audio recording**: Captured by the browser or Tauri webview via `MediaRecorder` (or `ScriptProcessorNode` PCM fallback on WebKitGTK). The audio blob exists in browser/webview memory only.
2. **Upload**: Sent over `localhost` WebSocket (or HTTP fallback) to the API process. Never touches a network interface beyond loopback.
3. **Temp storage**: On the one-shot paths (`POST /transcribe`, `/ws/transcribe`), written to a temp file for transcoding, deleted immediately after transcription in a `finally` block. **The streaming path (`/ws/stream`, v4) never writes audio to disk at all** — frames are decoded from an in-memory buffer with no ffmpeg step.
4. **Transcription**: Performed locally by faster-whisper. No cloud API calls.
5. **Transcript**: Returned to the browser/webview over localhost. Displayed in an editable textarea. Not persisted server-side.
6. **Clipboard** (desktop mode): Transcript text is sent via `fetch()` POST to the Rust HTTP server on `127.0.0.1:8001`, which writes to the system clipboard via `arboard`. The text is not stored or logged by the Rust process.
7. **Audio cues** (desktop mode): Voice command confirmations play through `rodio` on the same Rust HTTP server (`127.0.0.1:8001`). Sound data is embedded in the binary at compile time — no files are written or read at runtime.

## What is not logged

- Raw audio content
- Transcript text
- Any content derived from the user's speech

This describes the default configuration, which is the only configuration any
shipped launcher produces. Two diagnostic modes can capture content locally;
both are off by default and both are documented below rather than left for you
to discover.

## Developer and diagnostic modes

Three surfaces can hold or write user speech. None is enabled by any shipped
launcher, and none transmits anything off-machine.

| Surface | Default | How it turns on | What it holds |
| --- | --- | --- | --- |
| **Server trace** (protocol C9.3) | **off** | `STREAM_TRACE_DIR` env var set on the API process | Per-tick hypothesis and committed text as JSONL on disk, one file per session. Files persist until you delete them — point it at a gitignored path. Exists so `ops/scripts/policy_replay.py` can replay commit decisions offline. |
| **Client wire log** | **off** | `?debug=stream` in the frontend URL (deliberately not a setting — a reload clears it) | Wire messages including transcript text, in a capped memory buffer. Leaves the browser only if you click Export, which downloads a local JSON file. Cleared on session open and page unload. |
| **Recovery queue** | always on | — (failure path) | If a transcription request fails, that utterance's audio is retained **in memory** as a WAV so you can retry it instead of losing the text. Bounded (8 utterances, drop-oldest); released on retry success, on Clear, or when the page closes. Never written to disk. |

The first two are diagnostics you opt into. The third is a data-loss guard: it
exists because losing speech you already spoke is itself a harm, and it is the
narrowest retention that fixes it.

## What is logged

Operational telemetry only:
- Model download start/complete with duration
- Transcode start/complete with input format and duration
- Inference start/complete with duration and detected language
- HTTP request status codes

## What is stored

- **Model weights** (`~/.cache/voice-scribe/` on bare host, `data/cache/` in Docker): Downloaded from HuggingFace on first run. These are public model files, not user data.
- **Temp files** (`data/tmp/`): Transient audio files deleted after each request. Should be empty when idle.

## Network exposure

The API binds to `localhost:8084`. It is not accessible from other machines on the network. The Rust HTTP server (desktop mode) binds to `127.0.0.1:8001`.

CORS is restricted to:
- `http://localhost:5174` and `http://127.0.0.1:5174` (browser mode)
- `https://tauri.localhost` and `tauri://localhost` (desktop mode)
