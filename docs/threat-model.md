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

1. **Accidental LAN exposure**: If someone changes the bind address from localhost to 0.0.0.0 in the compose file, the API becomes network-accessible. The compose file ships with localhost binding only.
2. **Temp audio not cleaned up**: Container crash or OOM kill during transcription. Mitigation: monitor `data/tmp/` size.
3. **Transcript in logs**: A code change that logs the transcription result. Mitigation: code review, structured logging pattern that separates operational events from content.
4. **GPU setup confusion**: Contributors unable to get GPU passthrough working. Mitigation: `docker-setup.md` guide and `bootstrap_gpu_check.sh` script.
