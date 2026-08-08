# Voice Scribe

A local voice input system for developer workflows. Runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on a local GPU, streams transcription over WebSocket to a browser UI, and supports both push-to-talk and continuous dictation with client-side voice activity detection. No cloud services, no stored audio, no retained transcripts.

![Voice Scribe transcribing speech in real time: committed sentences accumulate in the transcript while a live region below shows the current utterance, its tentative tail in gray italic resolving into solid committed text](docs/assets/demo.gif)

*Live capture, unedited. The top pane is the transcript; the strip below it is the
utterance in progress. Gray italic is the tentative tail — still settling. Solid
text is committed: it is append-only and never rewrites itself.*

Speech arrives as partial text within ~1.3 s and stabilizes into committed text
that never rewrites itself — a LocalAgreement commit policy over a paced
re-decode loop, specified clause-by-clause in
[`docs/v4/protocol.md`](docs/v4/protocol.md) and enforced by tests that cite the
clause they check.

## What it does

- **Real-time streaming transcription (v4)** — a persistent `/ws/stream` session decodes as you speak: a flickering partial tail resolves into committed text that is append-only and never revised. Zero retractions is a property of the commit policy, not a hope — see [`docs/v4/protocol.md`](docs/v4/protocol.md) §5.
- **Push-to-talk** — record an utterance, get a transcript, copy it.
- **Continuous dictation** — mic stays open, client-side VAD ([Silero v4](https://github.com/snakers4/silero-vad), ONNX/WASM) gates speech, transcripts accumulate with automatic paragraph breaks based on speech timing.
- **Voice commands** — say "copy" or "clear" during continuous dictation. Exact-segment detection, stripped from output.
- **Hotkeys** — `Ctrl+Shift+Space` (record), `Ctrl+Shift+Y` (copy), `Ctrl+Shift+X` (clear), `Ctrl+Shift+S` (settings). In desktop mode, `Ctrl+Shift+Space` and `Ctrl+Shift+S` are intercepted by WebKitGTK and do not fire; Y and X work reliably.
- **System tray** — close-to-minimize with tray icon. Context menu (Record, Settings, Quit). Tooltip reflects recording state. Second close quits.
- **Live model swapping** — switch between Whisper models at runtime from the toolbar. Thread-safe reload with VRAM cleanup.
- **Light/dark theme** — toggle between dark (default) and light palettes. Preference persisted to `localStorage`, applied before first paint to prevent flash.
- **WebSocket streaming** — transcript segments arrive as faster-whisper produces them. HTTP POST fallback if the connection fails.

## Architecture

Two services over localhost. The frontend runs on the host (browser or Tauri webview). The backend runs in Docker (browser mode) or as a Tauri-managed Python sidecar (desktop mode).

```
Frontend (localhost:5174)               API (localhost:8084)
┌─────────────────────────┐             ┌──────────────────────────────┐
│ React + Vite            │  WebSocket  │ FastAPI + faster-whisper     │
│ MediaRecorder / VAD     │────────────>│ ffmpeg transcode             │
│ Voice commands, hotkeys │<────────────│ GPU inference (CUDA)         │
└─────────────────────────┘  segments   └──────────────────────────────┘
```

Desktop mode adds a Rust HTTP server on port 8001 for native clipboard writes (`arboard`) and audio cue playback (`rodio`), bypassing WebKitGTK's unreliable media subsystem.

Audio is transient: the one-shot path deletes its temp file in a `finally` block, and the streaming path never writes audio to disk at all. Transcripts exist only in browser/webview state and vanish on refresh. Nothing is logged, stored, or sent off-machine by default — two diagnostic modes can capture content locally and are off unless you turn them on; both are documented in [docs/privacy.md](docs/privacy.md).

## Quick start

```bash
# One-time: install frontend dependencies
npm install --prefix apps/web

# Browser mode — GPU (requires NVIDIA GPU + Container Toolkit)
make gpu-check   # verify GPU + container readiness
make dev         # start API container (CUDA) + frontend dev server

# Browser mode — CPU (no GPU required)
make dev-cpu     # start API container (CPU, small model) + frontend dev server

# Desktop mode — Tauri app with bare-host sidecar
make desktop     # start Tauri desktop app (GPU)
make desktop-cpu # start Tauri desktop app (CPU fallback)
```

Frontend: `http://localhost:5174` | API: `http://localhost:8084` (both bound to loopback only)

First run downloads the model from HuggingFace — `large-v3` is ~3 GB, so the
initial startup takes a few minutes on a normal connection. Subsequent starts
read from the cache (`data/cache/` in Docker, `~/.cache/voice-scribe/` bare-host).

See [docs/docker-setup.md](docs/docker-setup.md) for browser mode setup and [docs/v3/host-setup.md](docs/v3/host-setup.md) for desktop mode setup.

## Requirements

**Browser mode** (Docker):
- Docker Engine or Docker Desktop
- Node.js 20+
- GPU mode: NVIDIA GPU with CUDA support and drivers on the host

**Desktop mode** (Tauri):
- Rust toolchain, Python 3.10+, ffmpeg, NVIDIA drivers
- Linux system dependencies (WebKitGTK, GStreamer, ALSA)
- Tested on Ubuntu 22.04.5 LTS

### GPU sizing (default model: `large-v3`, float16)

Measured at the v4.0 field test (2026-08-01, RTX 3090 on WSL2 — full numbers in
`roadmap.md`): the service uses ~4.0 GiB VRAM idle with the model loaded and ~5.3 GiB
peak while streaming; streaming holds a 0.64 GPU duty cycle (p95 tick occupancy 0.58 of
the 750 ms budget) and one-shot transcription runs at roughly 12–17× real time.

- **Recommended (large-v3):** RTX 3090 / 4080-class or better, ≥ 10 GB VRAM. Measured on
  the 3090: p95 tick occupancy 0.58 of the 750 ms streaming budget, finalization 0.30–0.34 s
  typical (content-dependent outliers of a few seconds on dense passages), first partial
  ~1.6 s. The ≥ 10 GB floor covers swap-time double residency — a model swap constructs the
  new model while the old is still loaded.
- **Minimum (large-v3):** ≥ 8 GB VRAM and roughly half a 3090's fp16 throughput
  (RTX 3060 Ti / 4060-class — estimated from relative throughput, not tested). Streaming
  runs in sustained overrun at this tier: the backpressure ladder doubles the tick interval,
  so partials arrive at ~1.5 s cadence instead of 750 ms, and one-shot latency roughly
  doubles. Two caveats: 8 GB does not fit a large-to-large model swap (two models resident
  during the swap — restart the backend to change large models), and the overrun/ladder
  path has not yet been validated on live overrun audio (scheduled before the v4-overall
  gate).
- **Below that:** set `WHISPER_MODEL=medium` (about half the decode cost) or `small` —
  a 6 GB card runs `medium` comfortably. With no CUDA GPU, `make desktop-cpu` (or the CPU
  compose profile) runs `small` in int8: one-shot dictation is usable, streaming is not.

## Development

```bash
make dev          # Start API container (GPU) + frontend dev server
make dev-cpu      # Start API container (CPU) + frontend dev server
make desktop      # Start Tauri desktop app (GPU sidecar)
make desktop-cpu  # Start Tauri desktop app (CPU sidecar)
make api          # API container only
make web          # Frontend dev server only
make build        # Build the API Docker image
make test         # Run all tests (backend + frontend)
make gpu-check    # Verify GPU/container readiness
```

Backend tests run on the host and mock model loading — no GPU required. Build the
project environment once with `make venv`: it creates `apps/api/.venv` on Python
3.12 from `apps/api/requirements-dev.lock`, which is the exact pinned set CI
installs — so a local pass and a CI pass mean the same thing. `make test` uses
that venv automatically, and the Tauri sidecar picks it up as well.

```bash
# Run tests individually
cd apps/api && python -m pytest tests/ -v         # Backend
cd apps/web && npx vitest run                      # Frontend
cd apps/web && npx tsc --noEmit                    # Type check
```

## Project structure

```
apps/
  api/          FastAPI backend (Docker or bare-host sidecar, GPU inference)
  web/          React + TypeScript frontend (Vite, serves browser and Tauri)
  desktop/      Tauri v2 desktop shell (sidecar lifecycle, native clipboard/audio)
ops/
  docker/       Compose config, GPU passthrough
  scripts/      Smoke test, GPU bootstrap check
docs/
  docker-setup.md  Docker/browser mode setup and troubleshooting
  README.md     Documentation map — what is current, frozen, or a working note
  contract/     Runtime contract for downstream consumers (+ generated schema)
  v4/           Streaming protocol spec, commit-policy guide, field-test runbook
  v1/ v2/ v3/   Delivery reports, sign-offs, presentations (frozen snapshots)
  diagrams/     Mermaid source files for all diagrams
```

## Current state

**v4.1**, signed off 2026-08-07 (tag `v4.1.0`). Voice Scribe captures speech,
transcribes locally, and delivers text through an editable transcript pane with
clipboard integration. v4 added the real-time streaming path: a persistent
WebSocket session with a LocalAgreement commit policy, so text stabilizes
incrementally instead of arriving all at once. Push-to-talk, continuous
dictation, and voice commands work in browser and desktop modes. 351 tests pass
(200 frontend, 151 backend), TypeScript clean, Rust clean.

The desktop (Tauri) shell is **frozen** at a verified-green state — it works,
and it is not under active development; the reasons and the conditions that
would un-freeze it are recorded in `roadmap.md`.

Both modes share the same backend code and web UI. Desktop mode adds native OS
access (clipboard via `arboard`, audio via `rodio`) through a Rust HTTP server,
bypassing WebKitGTK limitations.

Voice Scribe is the capture primitive. Transformation, routing, and
instrumentation belong to downstream products. See `roadmap.md` for scope
boundaries and adjacent projects.

## How this was built

The engineering artifacts are the point of the repository as much as the app is:

- [`docs/v4/protocol.md`](docs/v4/protocol.md) — the streaming wire protocol as numbered, individually-amendable clauses; session tests name the clause they enforce, and amendments carry the date and evidence that produced them.
- [`docs/contract/runtime-contract.md`](docs/contract/runtime-contract.md) — the downstream interface, with a generated JSON schema and a drift test that fails CI if the two diverge.
- [`ops/scripts/policy_replay.py`](ops/scripts/policy_replay.py) — offline replay of the commit policy against recorded traces; `--verify` reproduces production decisions bit-exactly, so tuning questions become unit tests instead of GPU sweeps.
- [`ops/scripts/stream_bench.py`](ops/scripts/stream_bench.py) + [`docs/v4/field-test.md`](docs/v4/field-test.md) — the WER/latency harness and its runbook, with the committed report JSONs behind every number quoted above.
- [`roadmap.md`](roadmap.md) — the decision log: scope calls, measured results, and hypotheses retired by evidence.

## Contributing

Voice Scribe is a personal research vehicle. I'm not accepting pull requests and
I'm not maintaining it as a community project — the architecture reflects
specific scope decisions (see `roadmap.md`) that I intend to keep making
unilaterally.

**Issues are welcome for bugs and questions.** If you run it and something
breaks, tell me — reports from hardware I don't own are genuinely useful. I read
them; I don't promise to fix them.

**Forks are encouraged.** Apache-2.0, no strings. If you build something on top
of it, I'd like to hear about it.

## Citation and prior work

Voice Scribe implements published research. The model is
**Whisper** (Radford et al., ICML 2023); the incremental commit policy is
**local agreement** (Liu, Spanakis & Niehues, Interspeech 2020), applied to
Whisper as demonstrated by **Whisper-Streaming** (Macháček et al., 2023). Speech
gating uses **Silero VAD**, and inference runs through **faster-whisper** on
**CTranslate2**.

Full citations, and a plain statement of which parts of the streaming design are
original to this repository and which are not, are in
[`docs/references.md`](docs/references.md). A [`CITATION.cff`](CITATION.cff) is
provided if you need to cite the software itself.

## License

Apache License 2.0. See [LICENSE](LICENSE).

Redistributed third-party artifacts (Silero VAD weights, the vad-web worklet
bundle, and the self-hosted fonts) carry their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
