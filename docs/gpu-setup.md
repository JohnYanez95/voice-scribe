# GPU Setup Guide

Voice Scribe uses an NVIDIA GPU for fast transcription via faster-whisper. This guide covers the WSL2 + Docker Desktop setup.

## Requirements

- Windows 10/11 with WSL2
- NVIDIA GPU with CUDA support
- NVIDIA drivers installed in Windows (not inside WSL)
- Docker Desktop with WSL 2 backend enabled

## Verify GPU access

### 1. Check nvidia-smi in WSL

```bash
nvidia-smi
```

Should show your GPU name, driver version, and CUDA version. If this fails, update your NVIDIA drivers from Windows.

### 2. Check GPU inside Docker

```bash
docker run --rm --gpus all nvidia/cuda:12.6.3-runtime-ubuntu24.04 nvidia-smi
```

Should show the same GPU info. If this fails, check Docker Desktop settings:
- Settings > General > "Use the WSL 2 based engine" must be checked
- Settings > Resources > WSL Integration > enable for your distro

### 3. Run the bootstrap check

```bash
make gpu-check
```

This runs `ops/scripts/bootstrap_gpu_check.sh` which verifies both of the above.

## Troubleshooting

**nvidia-smi not found in WSL**: Install NVIDIA drivers in Windows, not inside WSL. WSL2 uses the host GPU driver.

**GPU not visible in Docker**: Try:
```bash
wsl --update
wsl --shutdown
```
Then restart Docker Desktop.

**Container starts but /health shows "device": "cpu"**: The `DEVICE` environment variable may be set to `cpu`, or GPU reservation is missing from the compose file. Check `ops/docker/compose.dev.yml`.

**Model downloads on every restart**: Check that `data/cache/` is writable and the volume mount in compose is correct. Run `ls -la data/cache/` — you should see a `models--Systran--faster-whisper-large-v3` directory after first run.

## CPU fallback

If GPU isn't available, edit `ops/docker/compose.dev.yml`:
1. Comment out the `deploy.resources.reservations` block
2. Change `DEVICE=cuda` to `DEVICE=cpu`
3. Optionally change `WHISPER_MODEL=large-v3` to `WHISPER_MODEL=small` for faster startup

CPU mode is slower but functional.
