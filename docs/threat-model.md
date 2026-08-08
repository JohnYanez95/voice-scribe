# Threat Model

## Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Microphone audio | High — raw speech | Browser memory, temp file (transient) |
| Transcript text | High — speech content | Browser memory, HTTP response |
| Session metadata | Low — timestamps, durations | Container logs |
| Model weights | None — public files | data/cache/ volume |
| Local service availability | Medium | Container runtime |

## Attack surfaces

### Upload endpoint (POST /transcribe)

- **Malformed input**: Mitigated by MIME validation, file size cap (10 MB), and audio duration cap (60 seconds).
- **Path traversal via filename**: Mitigated by using `tempfile.NamedTemporaryFile` which generates safe filenames. User-supplied filenames are not used for file paths.
- **Denial of service**: Mitigated by request size limits and ffmpeg timeout (30s). Single-user tool so resource exhaustion is self-inflicted.

### Temp storage

- **Leaked audio files**: Mitigated by `try/finally` cleanup pattern. Both input and transcoded files are deleted after each request.
- **Residual data**: If the container crashes mid-request, temp files may persist in `data/tmp/`. This directory should be treated as sensitive and cleared periodically.

### Browser origin handling

- **Cross-origin attacks**: CORS restricted to localhost origins only. No wildcard origins.
- **Mixed content**: Both services run on HTTP over localhost. No HTTPS required for local development.

### Debug configuration

- **Exposed debug endpoints**: FastAPI debug mode is not enabled. No `/docs` or `/redoc` in production.
- **Verbose logging**: Log level defaults to `info`. Transcript content is never logged regardless of level.

### Dependency chain

- **Supply chain**: Dependencies pinned in pyproject.toml and package-lock.json. Dependabot configured for weekly scanning. Container uses minimal base image.

## Most likely operational failures

1. **Accidental LAN exposure**: If someone removes the `127.0.0.1:` host-IP prefix from the compose port mapping, Docker binds `0.0.0.0` — and because Docker inserts its own iptables chain, a host firewall does not stop it. Both compose files ship with the loopback prefix and a comment saying why. Note that origin enforcement does not substitute for it: the WebSocket endpoints check `Origin` (which stops browsers, not `curl`), and `POST /transcribe` has no origin check at all, since CORS omits response headers rather than rejecting requests.

5. **Desktop clipboard/audio server (port 8001)**: In desktop mode the Rust process runs an unauthenticated HTTP server on `127.0.0.1:8001`; `POST /clipboard` writes the body to the system clipboard, `POST /audio/play` plays an embedded cue. This exists because WebKitGTK gates all IPC on user activation, which would break voice commands issued without focus — the bypass is deliberate and documented at the call site. Residual risk, accepted: a `text/plain` POST is a CORS *simple* request, so any web page open in any local browser can overwrite the clipboard (or trigger a sound) while the app runs. It cannot read the response, so this is defacement rather than exfiltration, and it requires code already running on the machine. Mitigation if taken: an `Origin`/`Host` allowlist check on the request side (~6 lines). Not taken while the desktop shell is frozen (see roadmap scope decision, 2026-08-04).
2. **Temp audio not cleaned up**: Container crash or OOM kill during transcription. Mitigation: monitor `data/tmp/` size.
3. **Transcript in logs**: A code change that logs the transcription result. Mitigation: code review, structured logging pattern that separates operational events from content.
4. **GPU setup confusion**: Contributors unable to get GPU passthrough working. Mitigation: `docker-setup.md` guide and `bootstrap_gpu_check.sh` script.
