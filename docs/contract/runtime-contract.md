# Voice Scribe Runtime Contract

**Contract version:** `v4.0-dev` (in-tree; becomes the `v4.0` git tag at release — see Versioning rule).

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

Three transports are supported. All bind to `localhost` only and share the same transcript field set for a completed utterance.

| Transport | Default | Path | Use case |
|-----------|---------|------|----------|
| WebSocket (streaming session) | v4.0+ | `ws://localhost:8084/ws/stream` | Live PCM ingestion; partial/committed text while the user speaks |
| WebSocket (one-shot) | Yes (v2.1+) | `ws://localhost:8084/ws/transcribe` | Streaming segments during inference on a complete blob |
| HTTP | Fallback | `http://localhost:8084/transcribe` | Single-shot, synchronous |

The one-shot WS and HTTP paths accept a binary audio blob, transcode it via ffmpeg to 16 kHz mono WAV before inference, and delete all temp files before the response/connection closes. The streaming path is different by design: it accepts raw 16 kHz mono `pcm_f32le` frames, runs no ffmpeg, and creates **no temp files at any point** — audio exists only in a bounded in-memory buffer (see Privacy guarantees).

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
| `409` | A `/ws/stream` session is active (v4.0+). A streaming session pins its model reference for the session's lifetime, so a mid-stream swap would hold double VRAM for minutes — stop the stream first. |
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

### `WS /ws/stream` (v4.0+)

Persistent streaming session: the client sends raw PCM frames while the user speaks; the server decodes on a paced tick and emits text incrementally. **The normative specification is `docs/v4/protocol.md` (protocol version 1)** — session tests enforce it clause by clause. Summary for consumers:

**Session shape:** JSON `start` (with `protocol_version: 1`, `sample_format: "pcm_f32le"`, `sample_rate: 16000`, optional `language`) → server `ready` (echoes config and the serving tunables in force) → binary PCM frames interleaved with JSON control (`flush` = utterance boundary, many per session; `stop` = session end; `reset` = destructive drop of the current utterance, acked) → server messages, each carrying `seq` and `utterance_id`.

**Server → client message types and how to treat them:**

| Type | Treatment |
|------|-----------|
| `partial` | Full replacement of the tentative tail. **Never persist, copy to clipboard, transform, or act on it.** May be retracted by the next `partial`. |
| `committed` | Append-only delta with `t0`/`t1` in received-audio seconds (not wall clock). Never revised by any later message. Safe to act on. |
| `final` | Authoritative for the utterance. Carries the utterance's committed text as a **literal prefix** of `raw`, plus `cleaned`, `language`, `duration`, `model_name`, `processing_mode`, `dropped_audio_ms`, `forced`. The only message carrying `cleaned`. Also the signal that a client-retained copy of the utterance audio may be dropped. |
| `error` | `code` is the stable machine-readable surface (`busy`, `preempted`, `protocol_violation`, `frame_too_large`, `unsupported_format`, `unsupported_version`, `model_swapping`, `decode_failure`, `overrun`, `session_timeout`); `detail` is human-readable and unstable — do not parse it. `fatal: true` means the session is over. |
| `ack` | Confirms `stop`/`reset`. |

`final.duration` is computed from received frame count, not from the decoder — on this path there is no WAV header to read.

**One session per server.** A second connection is accepted, sent `error{code:"busy"}`, and closed with `4409` — post-accept, so the code is observable (a pre-accept close surfaces to browsers as a generic connection failure). An incumbent that has sent no frames for ≥ 2 s is preempted by a new connection; a session idle for 10 s is torn down server-side.

**Close codes:** `4003` origin rejected (pre-accept — client fallback logic must not depend on reading it), `4408` protocol violation, `4409` busy/preempted, `1000` normal close after `stop`.

---

## Hard limits

These are enforced constraints, not configuration suggestions. Breaking them returns an error before any inference runs.

**One-shot paths (`POST /transcribe`, `/ws/transcribe`) — per-request limits:**

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Max upload size | 10 MB (`MAX_UPLOAD_MB`) | HTTP: 413 before processing. WS: error message before processing. |
| Max audio duration | 60 s (`MAX_AUDIO_SECONDS`) | HTTP only: checked after transcoding via `get_wav_duration()`. WS: **not enforced** — see Known Limitations. |
| Requests per connection | 1 | One audio blob per HTTP request or WS connection. |
| Concurrent requests | 1 (single-flight) | See Known Limitations. |

**Streaming path (`/ws/stream`) — the per-request limits above do not apply. A session is bounded by (protocol §6):**

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Max frame size | 64 KiB (`STREAM_MAX_FRAME_BYTES`) | Fatal error + close before buffering. Frame length must also be a nonzero multiple of 4 (f32). |
| Max uncommitted audio | 24 s (`STREAM_MAX_UNCOMMITTED_S`) | Oldest uncommitted audio dropped with an `overrun` signal — never silently. |
| Max utterance | 120 s (`STREAM_MAX_UTTERANCE_S`) | Server-side forced flush (`final.forced: true`). |
| Max session | 30 min (`STREAM_MAX_SESSION_S`) | Flush + fatal error + close. |
| Idle timeout | 10 s (`STREAM_IDLE_TIMEOUT_S`) | Session teardown; frees the single session slot. |
| Ingest rate | ≤ 2× real-time sustained | Fatal protocol violation — the wire is a live capture path, not a file upload. |
| Sessions per server | 1 | Second connection gets `busy` + close 4409; stale incumbents are preempted. |

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

- **Audio is transient (one-shot paths).** Both temp files (input and transcoded WAV) are deleted in a `finally` block that runs on success, failure, and WebSocket disconnect. Source: `transcribe.py:162-168`, `transcribe_ws.py:206-212`.
- **The streaming path writes no temp files at all.** `/ws/stream` never touches disk: there is no residue to survive a `kill -9`, so the crash-cleanup caveat in Operational Requirements does not apply to it. This is the strongest form of the zero-persistence claim.
- **Streaming audio retention is bounded in bytes, not "brief".** Session wall-clock length is unbounded (up to `STREAM_MAX_SESSION_S`), but at most `LEFT_CONTEXT_S + MAX_UNCOMMITTED_S` = 27 s of float32 mono 16 kHz audio — **≈ 1.7 MB** — exists in memory per session at any instant. Committed audio is discarded at each commit except the 3 s left-context carryover. The buffer is never serialized and is released on close, disconnect, and error alike.
- **No content logging.** Transcript text, intermediate streaming hypotheses, and raw audio bytes are never written to logs at any log level. Operational telemetry only: transcode start/complete (with elapsed time and input format), inference and decode-tick start/complete (with elapsed time, window length, and detected language). No audio content, no transcript content, no hypothesis content.
- **Localhost-only by default.** The API binds to `localhost` unless the bind address is explicitly overridden. CORS and WebSocket origin checks prevent cross-origin access from browser contexts (the origin check is replicated on `/ws/stream`).

---

## Known limitations

These are real gaps. They are named here so a downstream consumer knows exactly what is and is not enforced.

### WS has no per-request duration cap

`POST /transcribe` checks audio duration after transcoding (`get_wav_duration()`) and returns 400 if it exceeds `MAX_AUDIO_SECONDS`. The WebSocket path (`/ws/transcribe`) has no equivalent check. A client can send arbitrarily long audio over WS and inference will run to completion.

**Impact:** A workspace product that records long-form sessions and streams them via WebSocket should not assume the 60 s limit applies. The HTTP path enforces it; the WS path does not.

**Fix trigger:** When a downstream use case that needs long-form WS capture arises, the fix is to add `get_wav_duration()` after transcoding in `transcribe_ws.py` — one addition, same as the HTTP path. This is the same change required to decouple the UI cap from the backend constant (parking lot item in `roadmap.md`). Both close in one edit.

**v4.0 note:** `/ws/stream` is a second, *deliberate* instance of "no 60 s cap" — a session-long stream is unbounded per-utterance duration by design. It replaces the missing cap with its own explicit bounds (frame size, uncommitted-buffer cap, forced flush at 120 s, session ceiling, idle timeout — see Hard limits). The one-shot WS gap above remains an accidental omission; the streaming behaviour is a specified one.

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
4. **Temp file cleanup is guaranteed, but not idempotent on crash.** If the process is killed mid-inference, temp files may remain in `TEMP_DIR`. A consumer operating in a long-running sidecar context may want to clean `TEMP_DIR` at startup. This applies to the one-shot paths only — `/ws/stream` never writes temp files, so a crash leaves no residue on that path.
