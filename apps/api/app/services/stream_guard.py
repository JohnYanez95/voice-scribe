"""Single guard for the one-session rule and swap/stream mutual exclusion.

docs/v4/protocol.md §8: one module-level lock covers BOTH flags. Two flags
behind two locks is a check-then-act race — a swap can be accepted between a
stream's check and its start, and vice versa.
"""
from __future__ import annotations

import threading
from typing import Protocol


class StreamSessionHandle(Protocol):
    """What the guard needs from a session (implemented by the WS route)."""
    def last_frame_age_s(self) -> float: ...
    def request_preempt(self) -> None: ...


_lock = threading.Lock()
_active_session: StreamSessionHandle | None = None
_swap_in_progress: bool = False


def try_acquire_stream(
    session: StreamSessionHandle, preempt_grace_s: float
) -> tuple[str | None, StreamSessionHandle | None]:
    """Attempt to take the stream slot.

    Returns (None, None) on success, ("model_swapping"|"busy", None) on
    rejection, or ("preempting", incumbent) when the caller now owns the slot
    but must wait for the preempted incumbent to finish teardown (C1.4, C1.7).
    """
    global _active_session
    with _lock:
        if _swap_in_progress:
            return "model_swapping", None
        incumbent = _active_session
        if incumbent is None:
            _active_session = session
            return None, None
        if incumbent.last_frame_age_s() >= preempt_grace_s:
            _active_session = session
            incumbent.request_preempt()
            return "preempting", incumbent
        return "busy", None


def release_stream(session: StreamSessionHandle) -> None:
    """Release the slot — only if this session still holds it (a preempted
    session must not clear its preemptor's registration). Called in finally:
    on every session exit path (C8.2)."""
    global _active_session
    with _lock:
        if _active_session is session:
            _active_session = None


def try_begin_swap() -> bool:
    """Reject the swap if a stream is active (C8.1 — HTTP 409 at the route)."""
    global _swap_in_progress
    with _lock:
        if _active_session is not None:
            return False
        _swap_in_progress = True
        return True


def end_swap() -> None:
    global _swap_in_progress
    with _lock:
        _swap_in_progress = False


def stream_active() -> bool:
    with _lock:
        return _active_session is not None
