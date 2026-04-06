# Voice Scribe Desktop — Host Setup Guide

Bare-host setup for running Voice Scribe as a Tauri desktop application with GPU-accelerated transcription. The desktop app wraps the existing web UI in a native window and manages the Python API as a sidecar process — no Docker required.

## Prerequisites

### Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Verify: `cargo --version` and `rustc --version`.

### System Dependencies (Linux / WSL2)

WebKitGTK and GStreamer are required by Tauri v2 on Linux:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad
```

### Python 3.10+ Virtual Environment

```bash
cd apps/api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The sidecar resolves uvicorn from `.venv/bin/uvicorn` first, falling back to system PATH.

### ffmpeg

```bash
sudo apt install -y ffmpeg
```

Verify: `ffmpeg -version`. Required for audio transcoding (webm → 16kHz mono WAV).

### CUDA Driver

A working NVIDIA driver with CUDA support. Verify: `nvidia-smi` shows the GPU and a CUDA version.

## NVIDIA Runtime Libraries

The Python inference stack (faster-whisper / ctranslate2) needs `libcublas.so.12` and related CUDA runtime libraries at load time. These are not included in the NVIDIA driver — they come from pip packages.

**Either installation scope works:**

```bash
# Option A: install into the venv (recommended for isolated setups)
source apps/api/.venv/bin/activate
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12

# Option B: install at user scope (shared across projects)
pip install --user nvidia-cublas-cu12 nvidia-cudnn-cu12
```

**What happens under the hood:** The Rust sidecar builds `LD_LIBRARY_PATH` before spawning uvicorn. It scans two locations in order:

1. Venv site-packages — runs `.venv/bin/python -c "import site; print(site.getsitepackages())"` and looks for `nvidia/*/lib/` directories
2. User-scope site-packages — runs `python3 -c "import site; print(site.getusersitepackages())"` and looks for the same structure
3. Preserves any existing `LD_LIBRARY_PATH`

The resolved path is printed to stderr at sidecar spawn time (`Sidecar LD_LIBRARY_PATH: ...`), visible in the `make desktop` terminal output.

## First Run

```bash
make desktop
```

On first launch:
- Cargo compiles the Tauri shell (1–3 minutes, cached after first build)
- The sidecar downloads the Whisper model to `~/.cache/voice-scribe/` (large-v3 is ~3GB)
- Health poll runs at 500ms intervals with a 120-second timeout — model download fits within this window on most connections

The Vite dev server starts in parallel. The webview loads `http://localhost:5173`. The record button shows "Starting backend..." until the sidecar health check passes.

## Recommended Audio Input

Voice Scribe assumes a close-mic audio source. VAD segmentation and inference quality both degrade with distant or ambient-noise-contaminated input.

- **Headset or USB microphone** — use in any environment with background noise. The relevant property is proximity to the speaker, not price or noise cancellation tier.
- **Laptop microphone** — viable in quiet rooms with a single speaker. Not recommended for shared spaces, open offices, or environments with fans, HVAC, or other continuous noise sources.
- **Bluetooth headsets** — continuous recording mode keeps the microphone active, which holds Bluetooth in headset profile (HFP) rather than the audio-only profile (A2DP). This increases battery drain compared to passive listening. Not a functional issue — awareness for long sessions.

## Troubleshooting

### Microphone not working in the desktop app

WebKitGTK has a two-layer permission model for media devices:

1. **Feature gate** — `WebKitSettings.enable_media_stream` must be `true`
2. **Runtime grant** — the `permission-request` signal must be handled and the request allowed

The app configures both layers automatically in `main.rs`. If microphone access is still denied:
- Verify the system dependencies above are installed (specifically `libwebkit2gtk-4.1-dev`)
- Check that PulseAudio or PipeWire is running: `pactl info`
- Verify the microphone works in the browser at `http://localhost:5173` (the same web UI without the Tauri wrapper)

### `libcublas.so.12: cannot open shared object file`

The sidecar cannot find CUDA runtime libraries. Check:

1. **Verify the pip package is installed:**
   ```bash
   python3 -c "import nvidia.cublas; print(nvidia.cublas.__path__)"
   ```
   If this fails, install the package (see NVIDIA Runtime Libraries above).

2. **Check the resolved LD_LIBRARY_PATH:** Look for the `Sidecar LD_LIBRARY_PATH:` line in the `make desktop` terminal output. Verify it includes a path containing `nvidia/cublas/lib/`.

3. **Scope mismatch:** If the library is installed but the path is empty, the installation scope may not match what the sidecar scans. The sidecar checks both venv and user scope — but if the library is installed in a different venv or a system-wide location, it won't be found. Reinstall into `apps/api/.venv/` or at user scope.

### Port 8000 already in use

The `make desktop` target checks port 8000 before spawning the sidecar. If a Docker container from `make dev` is still running:

```bash
docker compose -f ops/docker/compose.dev.yml down
```

If `ss` is not available on your system (some minimal WSL2 installations), the port check is skipped with a warning. The sidecar health poll will detect the conflict — the sidecar exits immediately and the app shows an error dialog.

### Sidecar process not cleaned up

On normal window close, the Rust side sends SIGTERM to the sidecar (SIGKILL after 5 seconds). On Ctrl+C in the terminal, the Makefile trap handles cleanup via the PID file at `/tmp/voice-scribe-sidecar.pid`.

If a stale process remains:
```bash
ps aux | grep uvicorn
kill <pid>
```

## Docker Path (unchanged)

`make dev` continues to use Docker Compose with GPU passthrough. The desktop setup is an alternative, not a replacement. Both paths share the same backend code.
