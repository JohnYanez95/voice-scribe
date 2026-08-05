"""Per-tick hypothesis trace — the server-side twin of the client wire-log
developer mode (C9.3; docs/v4/protocol.md §9 amendments, 2026-08-04).

CONTENT-BEARING: records carry hypothesis and committed text. The privacy
posture mirrors wireDebug.ts exactly:

- disabled unless ``STREAM_TRACE_DIR`` is set (empty default; no shipped
  launcher — Docker, sidecar, Makefile — ever sets it),
- transcript content never passes through structlog (the only log line at
  enable time carries the directory and session id),
- the file's header record states that it contains transcript text,
- files persist until the operator deletes them — point the dir at a
  gitignored path (``data/tmp/`` recommended).

The trace exists so ``ops/scripts/policy_replay.py`` can re-run the pure
commit policy offline: every tunable/surface-form question becomes a
millisecond unit-level replay instead of a GPU sweep.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict
from typing import Any, TextIO

TRACE_VERSION = 1


class StreamTrace:
    """Lazy per-session JSONL writer. All methods are no-ops after close()."""

    def __init__(self, trace_dir: str, session_id: str) -> None:
        self.trace_dir = trace_dir
        self.session_id = session_id
        self.path = os.path.join(trace_dir, f"stream-trace-{session_id}.jsonl")
        self._fh: TextIO | None = None
        self._closed = False

    def _write(self, record: dict[str, Any]) -> None:
        if self._closed:
            return
        if self._fh is None:
            os.makedirs(self.trace_dir, exist_ok=True)
            self._fh = open(self.path, "a", encoding="utf-8")
        self._fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._fh.flush()

    def header(self, *, model_name: str, language: str | None,
               policy_config: Any, stream_settings: dict[str, Any]) -> None:
        self._write({
            "kind": "session",
            "trace_version": TRACE_VERSION,
            "note": "contains transcript text — operator opt-in diagnostic, "
                    "delete after use",
            "session_id": self.session_id,
            "model_name": model_name,
            "language": language,
            "policy_config": asdict(policy_config),
            "settings": stream_settings,
            "wall_anchor": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        })

    def tick(self, **fields: Any) -> None:
        self._write({"kind": "tick", "t_ms": round(time.monotonic() * 1000), **fields})

    def flush_record(self, **fields: Any) -> None:
        self._write({"kind": "flush", "t_ms": round(time.monotonic() * 1000), **fields})

    def close(self) -> None:
        self._closed = True
        if self._fh is not None:
            self._fh.close()
            self._fh = None


def maybe_trace(trace_dir: str, session_id: str) -> StreamTrace | None:
    """Factory honoring the single switch: empty dir → tracing disabled."""
    return StreamTrace(trace_dir, session_id) if trace_dir else None
