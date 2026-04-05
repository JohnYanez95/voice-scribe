# Voice Scribe v3 — Progress Report

**Date:** April 5, 2026
**Author:** Johnraymond Yanez
**Status:** Prerequisites in progress — v3.0 not started

---

## Current State

Two prerequisites gate v3.0. One is complete; the other is partially complete. No Tauri code exists yet.

| Item | Status | Commit |
|---|---|---|
| Prereq 1 — wsCleanupSet refactor | **Complete** | `8cbc933` |
| Prereq 2 — Config defaults | **Complete** | `8cbc933` |
| Prereq 2 — Bare-host startup validation | Pending | — |
| Prereq 2 — Host setup documentation | Pending | — |
| v3.0 — Tauri scaffolding | Not started | — |

---

## Prereq 1 — wsCleanupSet Refactor (Complete)

`wsCleanupRef` (`useRef<(() => void) | null>`) replaced with `wsCleanupSetRef` (`useRef<Set<() => void>>`). This closes the continuous-mode cleanup gap identified in the v2 delivery report — previously, only the most recent WebSocket connection's cleanup function survived in the ref; on unmount, earlier connections were not explicitly cleaned up.

### What changed

**`App.tsx`** — four touch points:

1. **Declaration** (line 31): single ref replaced with `Set` ref.
2. **Unmount** (line 67): iterates set, calls each cleanup, clears.
3. **Push-to-talk cancel** (line 84): iterates set, calls each cleanup, clears.
4. **Registration** (line 201): `cleanup` added to set. A `deregister` closure is assigned after `streamTranscribeAudio` returns and called by the `onComplete`, `onConnectionError`, and `onApplicationError` callbacks to remove completed connections from the set. This prevents unbounded growth during long continuous sessions.

The `deregister` variable is a `let` inside `triggerTranscription`. Each invocation creates its own binding. The callbacks capture it by reference and execute asynchronously after assignment — safe because no callback fires synchronously during `streamTranscribeAudio`.

**`App.test.tsx`** — two new tests in a `wsCleanupSet lifecycle` describe block:

| Test | Verifies |
|---|---|
| unmount cleans up all in-flight connections | Three concurrent VAD segments, unmount before any completes. All three cleanup functions called. |
| completed connections are deregistered | Three segments, two complete naturally, unmount. Only the third (in-flight) cleanup is called on unmount. |

The mock was updated to return unique `vi.fn()` cleanup functions per `streamTranscribeAudio` call and to track per-call data in a `streamCalls` array. Existing tests are unaffected — they use single-connection patterns that overwrite the same captured callbacks.

### What this enables for v3

In the browser SPA, the webview never navigates — component unmount is not a normal event. In Tauri, "close the panel" is real unmount. Without the Set pattern, closing the Tauri window during a continuous session would leak WebSocket connections for every segment except the most recent. This was a non-negotiable prereq from the Principal before any Tauri code.

---

## Prereq 2 — Host Environment Validation (In Progress)

### Config defaults (complete)

`config.py` defaults changed from Docker-centric paths to host-friendly paths:

| Variable | Old default | New default |
|---|---|---|
| `MODEL_CACHE_DIR` | `/cache` | `~/.cache/voice-scribe` |
| `TEMP_DIR` | `/tmp/voice-scribe` | `tempfile.gettempdir() + "/voice-scribe"` |

`compose.dev.yml` explicitly sets both variables to the Docker paths — `make dev` behavior is unchanged. 41 backend tests pass.

### Bare-host startup validation (pending)

Gate: `cd apps/api && source .venv/bin/activate && uvicorn app.main:app --host 127.0.0.1 --port 8000` starts, `GET /health` returns `"device": "gpu"`, model loads from `~/.cache/voice-scribe`.

This requires a Python venv at `apps/api/.venv/` with `faster-whisper`, `uvicorn`, `ffmpeg` on `PATH`, and CUDA toolkit on the host. Not yet validated.

### Host setup documentation (pending)

Close condition: `docs/v3/host-setup.md` that gets a fresh WSL instance from zero to a running API without Docker.

---

## v2 Known Limitations — Close-out

Three items from the v2 delivery report's "Known Limitations" section are now closed:

| Item | Resolution |
|---|---|
| `wsCleanupRef` continuous-mode gap | Closed by Prereq 1. Set pattern replaces single ref. |
| `PARAGRAPH_BREAK_MS` timing includes GPU latency | Closed by v2.3.3. `speechEndTime` captured at `onSpeechEnd`, threaded through `triggerTranscription`. Elapsed measures speech gaps, not inference latency. |
| Hotkey reset not delivered | Closed by v2.3.2. Ctrl+Shift+R removed; automatic paragraph gaps cover the use case. |

Remaining open: **WebSocket path not covered by smoke test.** Unit test coverage exists; no end-to-end script. Not blocking v3.

---

## Test State

| Suite | Count | Status |
|---|---|---|
| Frontend (vitest) | 68 | All pass |
| Backend (pytest) | 41 | All pass |
| **Total** | **109** | **Green** |

---

## What Remains Before v3.0

1. **Prereq 2 bare-host validation** — run the API outside Docker, confirm GPU inference works from host Python.
2. **Prereq 2 documentation** — `docs/v3/host-setup.md`.
3. **v3.0 scope** — Tauri scaffolding, sidecar lifecycle, CORS for Tauri origin, backend-readiness gate (Tauri-only), `make desktop` target. See roadmap for full specification.

---

## Reviewer Notes

### For PM

Scope is clean. The v3 prerequisites are sequenced correctly — code refactor on main first, isolated from Tauri work. No scope additions beyond what the roadmap specifies. The wsCleanupSet refactor required no API changes, no new dependencies, no new state. Config defaults changed; Docker path verified as no-regression.

The v2.3.x implementation code (voice command vocabulary, paragraph timing fix, hotkey removal) was committed alongside the v3 prereqs in `8cbc933` — these were already in the working tree from completed v2.3.x milestones but had not been committed to git. The commit message documents both sets of changes.

Three v2 known limitations are now closed. One remains open (WebSocket smoke test) — not blocking.

### For Principal

**wsCleanupSet correctness argument:** Each `triggerTranscription` call creates a fresh `let deregister` binding. The callbacks passed to `streamTranscribeAudio` capture this binding by reference. The `deregister` function is assigned after `streamTranscribeAudio` returns — safe because all callbacks fire asynchronously on WebSocket events, never synchronously during the `streamTranscribeAudio` call. The optional chaining (`deregister?.()`) handles the theoretical edge case where a callback fires before assignment, though this cannot happen in practice.

The Set deregister pattern prevents unbounded growth. Without it, a 30-minute continuous session generating one segment every 3-5 seconds would accumulate 360-600 stale cleanup entries — each a closure holding a reference to a closed WebSocket. With deregister, the Set stays bounded to the number of concurrently in-flight segments (typically 1-2).

**Config defaults:** `os.path.expanduser("~")` resolves to the current user's home directory in both Docker (`/root` or the container user) and host contexts. In Docker, `compose.dev.yml` overrides with `/cache` — the expansion never runs. On host, it resolves to the user's actual home. `tempfile.gettempdir()` returns `/tmp` on Linux/WSL — functionally equivalent to the old hardcoded `/tmp/voice-scribe` on host, but portable.

**Outstanding concern for Prereq 2 gate:** The bare-host validation must confirm that `faster-whisper` loads the model from `~/.cache/voice-scribe` without the Docker volume mount. The `MODEL_CACHE_DIR` env var is read at class definition time in `config.py` — verify that the host venv's `PYTHONPATH` and working directory don't interfere with the `os.path.expanduser` resolution.
