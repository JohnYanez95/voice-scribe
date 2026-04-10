# Voice Scribe Runtime Contract

**Contract version:** `v3.4.1` (equals the Voice Scribe git tag of the release that ships this file).

---

## Purpose and scope

This document describes the surface Voice Scribe guarantees to downstream consumers. A downstream consumer is any process — separate repository, desktop shell, or test harness — that communicates with a running Voice Scribe API over localhost.

Anything not listed here is implementation detail and may change between releases without notice. The machine-readable companion (`runtime-contract.schema.json`) covers the same surface as JSON Schema.

This contract describes what exists today. It does not promise future enrichments (segment timestamps, confidence scores, structured boundaries). Those are additive changes that will appear in a future contract version when a concrete downstream need drives them.

---

## Versioning rule

Contract version = Voice Scribe git tag of the release that ships it. Breaking changes (removed fields, changed field types, removed endpoints) bump the major component. Additive changes (new optional fields, new endpoints) do not require a major bump. There is no separate `contract/v1` track and no SemVer on the Python package.

---

## Transport

Two transports are supported. Both bind to `localhost` only and share the same response body shapes for successful transcription.

| Transport | Default | Path | Use case |
|-----------|---------|------|----------|
| WebSocket | Yes (v2.1+) | `ws://localhost:8084/ws/transcribe` | Streaming segments during inference |
| HTTP | Fallback | `http://localhost:8084/transcribe` | Single-shot, synchronous |

Both transports:
- Accept a binary audio blob from the client
- Transcode via ffmpeg to 16 kHz mono WAV before inference
- Return the same transcript field set on success
- Delete all temp files before the response/connection closes

---

## Endpoint reference

### `GET /health`

Returns current API status and model state. Safe to poll — no side effects.

**Response — `200 OK`:**
```json
{
  "status": "ok",
  "model_loaded": true,
  "device": "cuda",
  "model_name": "large-v3"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `status` | `string` | Always `"ok"` when the server is reachable |
| `model_loaded` | `boolean` | `false` during startup before the model loads |
| `device` | `string` | `"cuda"` or `"cpu"` — reflects the `DEVICE` env var |
| `model_name` | `string` | Currently loaded model name |

A `model_loaded: false` response means the server is up but inference is not yet ready. Poll until `true` before sending audio.

---

### `POST /transcribe`

Synchronous HTTP transcription. Validates MIME type, enforces size and duration caps, returns the full transcript in one response.

**Request:** `multipart/form-data`

| Field | Required | Notes |
|-------|----------|-------|
| `file` | Yes | Audio file. MIME type must be in the allowlist (see Hard Limits). |
| `language` | No | BCP-47 language hint (e.g. `"en"`, `"ja"`). Omit to auto-detect. |

**Response — `200 OK`:**
```json
{
  "raw": "hello world this is a test",
  "cleaned": "Hello world this is a test",
  "language": "en",
  "duration": 3.5,
  "processing_mode": "cuda",
  "model_name": "large-v3"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `raw` | `string` | Whisper output, whitespace-normalised, no other transforms |
| `cleaned` | `string` | `raw` with first letter capitalised and trailing whitespace stripped |
| `language` | `string` | BCP-47 code detected or provided |
| `duration` | `number` | Audio duration in seconds (from WAV header after transcoding) |
| `processing_mode` | `string` | `"cuda"` or `"cpu"` |
| `model_name` | `string` | Model that performed this inference |

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | Missing or unsupported MIME type, audio too long (> `MAX_AUDIO_SECONDS`) |
| `413` | File too large (> `MAX_UPLOAD_MB` MB) |
| `422` | Missing required `file` field |
| `500` | ffmpeg transcode failure or inference failure |

Error body: `{"detail": "<message>"}` — matches `ErrorResponse` in the schema file.

---

### `GET /models`

Returns the list of available model names and which is currently loaded.

**Response — `200 OK`:**
```json
{
  "models": [
    {"name": "small", "is_current": false},
    {"name": "large-v3", "is_current": true}
  ],
  "current_model": "large-v3"
}
```

The available set is configured at startup via `WHISPER_AVAILABLE_MODELS`. A consumer must not assume a fixed set.

---

### `POST /models/swap`

Hot-swaps the loaded model. Blocks until the current in-flight inference (if any) completes before unloading the old model. See Known Limitations — concurrency.

**Request body:**
```json
{"model_name": "small"}
```

**Response — `200 OK`:**
```json
{
  "previous_model": "large-v3",
  "current_model": "small",
  "swap_duration": 2.5
}
```

`swap_duration` is wall-clock seconds to unload the old model and load the new one.

If the requested model is already loaded, returns immediately with `swap_duration: 0.0`.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | `model_name` not in the available set |
| `500` | Model load failure |

---

### `WS /ws/transcribe`

Streaming WebSocket transcription. Sends segments as inference runs, then a final complete message.

**Connection:** `ws://localhost:8084/ws/transcribe?language=en&audio_format=audio/webm`

| Query parameter | Required | Notes |
|-----------------|----------|-------|
| `language` | No | BCP-47 language hint. Omit to auto-detect. |
| `audio_format` | No | MIME type hint for container suffix (e.g. `audio/webm`, `audio/ogg`). Used only as a filename suffix hint — does not gate the request. See Known Limitations. |

**Protocol:**

1. Client connects. Server checks `Origin` header against the allowlist. Closes with code `4003` if origin is rejected.
2. Client sends one binary message containing the full audio blob.
3. Server streams zero or more `segment` messages as inference runs.
4. Server sends one `complete` message when all segments are done.
5. Connection closes.

On any error, the server sends an `error` message and closes.

**`segment` message:**
```json
{"type": "segment", "text": "hello world"}
```

**`complete` message:**
```json
{
  "type": "complete",
  "raw": "hello world this is a test",
  "cleaned": "Hello world this is a test",
  "language": "en",
  "duration": 3.5,
  "model_name": "large-v3",
  "processing_mode": "cuda"
}
```

Field semantics match `POST /transcribe` — see table above.

**`error` message:**
```json
{"type": "error", "detail": "Audio transcoding failed"}
```

**WebSocket close codes:**

| Code | Meaning |
|------|---------|
| `4003` | Origin rejected — not in the allowlist |
| Normal close | Inference complete |

---

## Hard limits

These are enforced constraints, not configuration suggestions. Breaking them returns an error before any inference runs.

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Max upload size | 10 MB (`MAX_UPLOAD_MB`) | HTTP: 413 before processing. WS: error message before processing. |
| Max audio duration | 60 s (`MAX_AUDIO_SECONDS`) | HTTP only: checked after transcoding via `get_wav_duration()`. WS: **not enforced** — see Known Limitations. |
| Requests per connection | 1 | One audio blob per HTTP request or WS connection. |
| Concurrent requests | 1 (single-flight) | See Known Limitations. |

**MIME allowlist (HTTP only):**

| MIME type | Extension |
|-----------|-----------|
| `audio/webm` | `.webm` |
| `audio/ogg` | `.ogg` |
| `audio/wav` | `.wav` |
| `audio/x-wav` | `.wav` |
| `audio/mp4` | `.mp4` |
| `audio/mpeg` | `.mp3` |

Codec parameters are stripped before validation (`audio/webm;codecs=opus` → `audio/webm`).

---

## Privacy guarantees

These are runtime behaviours, not aspirational statements.

- **Audio is transient.** Both temp files (input and transcoded WAV) are deleted in a `finally` block that runs on success, failure, and WebSocket disconnect. Source: `transcribe.py:162-168`, `transcribe_ws.py:206-212`.
- **No content logging.** Transcript text and raw audio bytes are never written to logs at any log level. Operational telemetry only: transcode start/complete (with elapsed time and input format), inference start/complete (with elapsed time and detected language). No audio content, no transcript content.
- **Localhost-only by default.** The API binds to `localhost` unless the bind address is explicitly overridden. CORS and WebSocket origin checks prevent cross-origin access from browser contexts.

---

## Known limitations

These are real gaps. They are named here so a downstream consumer knows exactly what is and is not enforced.

### WS has no per-request duration cap

`POST /transcribe` checks audio duration after transcoding (`get_wav_duration()`) and returns 400 if it exceeds `MAX_AUDIO_SECONDS`. The WebSocket path (`/ws/transcribe`) has no equivalent check. A client can send arbitrarily long audio over WS and inference will run to completion.

**Impact:** A workspace product that records long-form sessions and streams them via WebSocket should not assume the 60 s limit applies. The HTTP path enforces it; the WS path does not.

**Fix trigger:** When a downstream use case that needs long-form WS capture arises, the fix is to add `get_wav_duration()` after transcoding in `transcribe_ws.py` — one addition, same as the HTTP path. This is the same change required to decouple the UI cap from the backend constant (parking lot item in `roadmap.md`). Both close in one edit.

### WS does not enforce a MIME allowlist

`POST /transcribe` calls `validate_mime_type()` before doing anything else. The WebSocket path does not. The `audio_format` query parameter is used only to choose a file extension suffix for the temp file — an unknown value produces an empty suffix, and ffmpeg probes the bytes directly.

Secondary detail: the WS suffix table (`_MIME_TO_SUFFIX` in `transcribe_ws.py`) omits `audio/x-wav`. The HTTP allowlist includes it. Even as a hint, the two transports differ by one entry.

**Impact:** A consumer cannot assume "MIME allowlist enforced" applies uniformly across both transports. The WS path will attempt to process any audio bytes ffmpeg can probe, including formats not on the HTTP allowlist.

**Fix trigger:** Same parking lot item as the duration cap above — both are addressed together when long-form WS capture becomes a concrete requirement.

### Concurrency is single-flight

The backend handles one transcription at a time. The model is loaded once at startup and accessed via a module-level singleton with a threading lock. A model swap blocks until any in-flight inference completes before unloading the old model (`transcription.py`), but VRAM cleanup is deferred until the inference thread releases its local reference (`transcribe_ws.py:130-135`).

**Impact:** A downstream consumer that wants to fire multiple parallel transcriptions will queue behind one another, not run in parallel. This is by design for a single-user, single-GPU tool. If a workspace product needs concurrent transcription, it must spawn multiple Voice Scribe processes.

---

## Origin allowlist

HTTP requests are gated by FastAPI's `CORSMiddleware`. WebSocket connections are gated by a manual origin check at `transcribe_ws.py:51-55` — `CORSMiddleware` does not cover WebSocket.

**Default allowed origins:**
```
http://localhost:5174
http://127.0.0.1:5174
https://tauri.localhost
tauri://localhost
```

To add an origin — e.g. a workspace dev server on port 5175 — set the `CORS_ORIGINS` environment variable:

```bash
CORS_ORIGINS="http://localhost:5174,http://localhost:5175,https://tauri.localhost,tauri://localhost"
```

A WebSocket connection from an origin not in the list closes immediately with code `4003`. This will look like a contract bug; the actual cause is the missing origin entry.

---

## Operational requirements for a downstream consumer

1. **Voice Scribe must be running.** The workspace product is responsible for starting and health-checking the Voice Scribe API before sending audio. Poll `GET /health` until `model_loaded: true`.
2. **The consumer's origin must be in the allowlist.** Set `CORS_ORIGINS` at Voice Scribe startup to include the workspace dev server origin. If running in a Tauri context, `https://tauri.localhost` and `tauri://localhost` are in the default list.
3. **Single-flight semantics must be respected.** Do not send a second audio blob before the first completes. The server will not reject the second request outright, but inference results will be serialised and VRAM pressure may increase during a model swap.
4. **Temp file cleanup is guaranteed, but not idempotent on crash.** If the process is killed mid-inference, temp files may remain in `TEMP_DIR`. A consumer operating in a long-running sidecar context may want to clean `TEMP_DIR` at startup.
