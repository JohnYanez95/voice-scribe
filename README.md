# Voice Scribe

Local-first speech-to-text for development workflows.

Record speech in a browser UI, transcribe locally via [faster-whisper](https://github.com/SYSTRAN/faster-whisper), and copy the result into your tools.

## Quick Start

```bash
# Verify GPU + Docker setup
make gpu-check

# Start development services
make dev
```

The frontend runs at `http://localhost:5173`. The API runs at `http://localhost:8000`.

## Requirements

- Docker Desktop with WSL 2 backend
- NVIDIA GPU with CUDA support
- Node.js 20+
- Chrome (supported browser for v1)

## Development

```bash
make dev        # Start all services
make build      # Build the API container
make test       # Run all tests
make gpu-check  # Verify GPU/container readiness
```

See [docs/gpu-setup.md](docs/gpu-setup.md) for GPU troubleshooting.
