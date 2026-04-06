# Voice Scribe — Docker Setup

Run Voice Scribe with the backend in a Docker container. Two modes: GPU (CUDA inference) and CPU (no GPU required).

## Prerequisites

- Docker Engine or Docker Desktop
- Node.js 20+

GPU mode additionally requires:
- NVIDIA GPU with CUDA support
- NVIDIA drivers installed on the host (Windows: install in Windows, not inside WSL)
- NVIDIA Container Toolkit (Docker Desktop enables this automatically with WSL 2 backend)

## Quick Start

### GPU

```bash
make gpu-check   # verify GPU + container readiness
make dev         # start API container (CUDA) + frontend dev server
```

### CPU

```bash
npm install --prefix apps/web   # once, before first run
make dev-cpu                    # start API container (CPU) + frontend dev server
```

Frontend: `http://localhost:5173` | API: `http://localhost:8000`

## What each command does

`make dev` runs the GPU pre-flight check, starts the API container with `DEVICE=cuda` and the `large-v3` Whisper model, then starts the Vite dev server.

`make dev-cpu` skips the GPU check, starts the API container with `DEVICE=cpu` and the `small` Whisper model (~500MB), no GPU reservation. Inference is slower but functional on any machine with Docker.

On first run, the Whisper model downloads inside the container. This is cached in `data/cache/` and reused on subsequent starts.

## Stopping

```bash
# GPU
docker compose -f ops/docker/compose.dev.yml down

# CPU
docker compose -f ops/docker/compose.cpu.yml down
```

Ctrl+C in the terminal stops the Vite dev server. The API container runs in the background and must be stopped separately with the command above.

## GPU Verification

```bash
# Host — should show GPU name, driver version, CUDA version
nvidia-smi

# Inside Docker — same output
docker run --rm --gpus all nvidia/cuda:12.6.3-runtime-ubuntu24.04 nvidia-smi

# Automated check
make gpu-check
```

If the Docker test fails on WSL2, check Docker Desktop settings:
- Settings > General > "Use the WSL 2 based engine" must be checked
- Settings > Resources > WSL Integration > enable for your distro

If `nvidia-smi` is not found in WSL: install NVIDIA drivers in Windows, not inside WSL. WSL2 uses the host GPU driver.

After changing driver or Docker settings:
```bash
wsl --update && wsl --shutdown
```
Then restart Docker Desktop.

## Troubleshooting

**Container starts but `/health` shows `"device": "cpu"` when expecting GPU**: The compose override may be active. Verify you ran `make dev`, not `make dev-cpu`.

**Model downloads on every restart**: Check that `data/cache/` is writable and persists. Run `ls data/cache/` — you should see a `models--Systran--faster-whisper-*` directory after first run.

**Port 8000 already in use**: A previous container or desktop sidecar may still be running.
```bash
docker compose -f ops/docker/compose.dev.yml down
```

**Frontend can't connect to API**: Ensure the container is running (`docker ps`). The frontend expects the API at `http://localhost:8000`. CORS allows `localhost:5173` and `127.0.0.1:5173`.
