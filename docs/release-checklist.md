# Release Checklist

Complete all items before any public release.

## Documentation

- [ ] README with quick start instructions
- [ ] SECURITY.md with vulnerability reporting process
- [ ] Privacy documentation (docs/privacy.md)
- [ ] Threat model documentation (docs/threat-model.md)
- [ ] GPU setup guide (docs/gpu-setup.md)

## Security

- [ ] No secrets in repository (search for API keys, tokens, passwords)
- [ ] No real audio files or transcripts committed
- [ ] `.env.example` contains only placeholder/default values
- [ ] CORS origins restricted to localhost
- [ ] API binds to localhost only
- [ ] Container runs as non-root user
- [ ] Transcript content is not logged at any log level
- [ ] Temp files are cleaned up on both success and error paths
- [ ] Dependency scanning enabled (Dependabot)
- [ ] No debug endpoints exposed

## Functionality

- [ ] `make gpu-check` passes
- [ ] `docker compose up` starts cleanly
- [ ] `GET /health` returns `model_loaded: true`
- [ ] Smoke test passes (`bash ops/scripts/smoke_test.sh ops/scripts/test.mp3`)
- [ ] Frontend records, transcribes, and displays text
- [ ] Transcript is editable
- [ ] Copy to clipboard works
- [ ] Backend tests pass (pytest)
- [ ] Frontend tests pass (vitest)

## Build

- [ ] Docker image builds without errors
- [ ] Model cache persists across container restarts
- [ ] CPU fallback mode works (DEVICE=cpu)
- [ ] No hard-coded paths or machine-specific configuration
