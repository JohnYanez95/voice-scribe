"""LocalAgreement-2 commit policy — pure functions, no model, no WebSocket, no threads.

This module owns the correctness of the streaming path (docs/v4/protocol.md §7).
Everything operates in absolute sample coordinates (the session clock): hypotheses
from different window positions must be compared in the same reference frame, or
agreement silently misaligns after a buffer slide.

The policy's structural rule (protocol C5.5): every element either commits or
withholds — none revises. Vetoes (word-probability floor, edge guard) only
withhold; agreement and holdback force-commit only commit. That is what makes
"zero retractions by construction" an honest claim.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class Word:
    """One hypothesis word in absolute session coordinates (seconds)."""
    text: str          # raw surface form — this is what gets committed (C7.3)
    start: float
    end: float
    probability: float


@dataclass(frozen=True)
class PolicyConfig:
    sample_rate: int = 16000
    left_context_s: float = 3.0
    max_uncommitted_s: float = 24.0
    safety_s: float = 3.0
    word_prob_floor: float = 0.5
    edge_guard_s: float = 0.6
    max_holdback_ticks: int = 6
    # Boundary suppression tolerance: one Whisper frame (20 ms). Re-decodes
    # from a different window position re-time words by up to one frame; a
    # committed word whose end drifts later than the frontier by less than
    # this must still be suppressed or it commits twice (append-only, so the
    # duplicate is permanent and invisible to the retraction reducer).
    frame_tolerance_s: float = 0.02

    def validate(self) -> None:
        """Window invariant (C7.1): pad_or_trim silently truncates past 30 s."""
        total = self.left_context_s + self.max_uncommitted_s + self.safety_s
        if total > 30.0:
            raise ValueError(
                f"window invariant violated: left_context ({self.left_context_s}) + "
                f"max_uncommitted ({self.max_uncommitted_s}) + safety ({self.safety_s}) "
                f"= {total} > 30.0"
            )


@dataclass(frozen=True)
class WindowPlan:
    """Where the next decode window starts, and what the buffer must drop."""
    window_start_sample: int      # decode from here (includes left context)
    context_end_sample: int       # words ending at/before this are suppressed
    overflow_drop_samples: int    # oldest uncommitted samples to drop (C5.6); 0 normally


@dataclass(frozen=True)
class PolicyState:
    """Immutable per-utterance policy state. The session loop owns the bytes."""
    committed_words: tuple[Word, ...] = ()
    committed_through_sample: int = 0
    prev_hypothesis: tuple[Word, ...] | None = None
    holdback_frontier: int = -1   # frontier position the counter is anchored to
    holdback_ticks: int = 0


@dataclass(frozen=True)
class CommitDecision:
    newly_committed: tuple[Word, ...]
    tentative: tuple[Word, ...]
    holdback_fired: bool
    veto_prob: bool               # prob floor withheld at least one agreed word
    veto_edge: bool               # edge guard withheld at least one agreed word
    state: PolicyState


def normalize_token(text: str) -> str:
    """Comparison key (C7.3): NFKC → casefold → strip edge punctuation.

    Word-internal apostrophes/hyphens survive. Whisper re-punctuates and
    re-capitalizes the terminal word on nearly every pass; comparing raw
    surface forms stalls the frontier one word behind indefinitely.
    """
    t = unicodedata.normalize("NFKC", text).casefold().strip()
    start, end = 0, len(t)
    while start < end and unicodedata.category(t[start]).startswith("P"):
        start += 1
    while end > start and unicodedata.category(t[end - 1]).startswith("P"):
        end -= 1
    return t[start:end]


def plan_window(
    committed_through_sample: int,
    total_samples: int,
    cfg: PolicyConfig,
) -> WindowPlan:
    """Plan the next decode window (C7.1, C7.2, C5.6).

    The window starts left_context_s before the committed boundary (or at 0).
    If uncommitted audio exceeds max_uncommitted_s, the overflow is reported so
    the session can drop the *oldest* uncommitted samples — never silently.
    """
    left_ctx = int(cfg.left_context_s * cfg.sample_rate)
    max_unc = int(cfg.max_uncommitted_s * cfg.sample_rate)

    uncommitted = total_samples - committed_through_sample
    overflow = max(0, uncommitted - max_unc)
    effective_committed_edge = committed_through_sample + overflow

    window_start = max(0, effective_committed_edge - left_ctx)
    return WindowPlan(
        window_start_sample=window_start,
        context_end_sample=effective_committed_edge,
        overflow_drop_samples=overflow,
    )


def localize(
    hyp_words: list[tuple[str, float, float, float]],
    window_start_sample: int,
    context_end_sample: int,
    cfg: PolicyConfig,
) -> tuple[Word, ...]:
    """Convert window-relative decoder words to absolute Words (C7.2).

    hyp_words: (text, start_s, end_s, probability) with times relative to the
    window start. Words that end inside the left-context region are re-decoded
    committed audio and are suppressed here — by timestamp, never by string
    matching (fuzzy text suppression fails exactly when the model re-punctuates).
    A word *straddling* the boundary (starts inside context, ends after it)
    survives: its content extends past the committed edge.
    """
    offset_s = window_start_sample / cfg.sample_rate
    boundary_s = context_end_sample / cfg.sample_rate
    out: list[Word] = []
    for text, start, end, prob in hyp_words:
        text = text.strip()
        if not text:
            continue
        abs_start, abs_end = offset_s + start, offset_s + end
        if abs_end <= boundary_s + cfg.frame_tolerance_s:
            continue  # inside re-decoded committed audio (± one decoder frame)
        out.append(Word(text=text, start=abs_start, end=abs_end, probability=prob))
    return tuple(out)


def retention_start_sample(committed_through_sample: int, cfg: PolicyConfig) -> int:
    """First sample the session buffer must retain (committed left context)."""
    return max(0, committed_through_sample - int(cfg.left_context_s * cfg.sample_rate))


def _common_prefix_len(a: tuple[Word, ...], b: tuple[Word, ...]) -> int:
    n = 0
    for wa, wb in zip(a, b):
        if normalize_token(wa.text) != normalize_token(wb.text):
            break
        n += 1
    return n


def agree(
    state: PolicyState,
    curr: tuple[Word, ...],
    buffer_end_sample: int,
    cfg: PolicyConfig,
) -> CommitDecision:
    """One tick of LocalAgreement-2 (C7.3–C7.5).

    Commit-eligible words are, in order of application:
      1. within the longest common normalized-prefix of prev and curr,
      2. non-terminal in BOTH hypotheses (terminal words carry unstable
         punctuation/casing — without this, holdback becomes the steady-state
         commit path on ordinary speech),
      3. ending at least edge_guard_s before the buffer end (truncation
         hallucinations agree across ticks with good probabilities — the edge
         guard is the structural defense, C7.4),
      4. at or above word_prob_floor (stop at the first word below it).

    Committed text is the raw surface form from the NEWER hypothesis.

    Holdback (C7.5) is frontier-anchored: the counter keys on the commit
    frontier and resets only when the frontier advances. When it fires, the
    newest hypothesis is committed WITHOUT agreement or the probability floor,
    but still behind the edge guard (never commit ungrounded edge words).
    """
    buffer_end_s = buffer_end_sample / cfg.sample_rate
    edge_limit_s = buffer_end_s - cfg.edge_guard_s

    # Align both hypotheses to the current committed boundary (C5.1): any word
    # ending at or before it is already-committed audio — comparing or
    # re-committing it would duplicate text. This also re-aligns prev when the
    # previous tick committed words out of it.
    boundary_s = state.committed_through_sample / cfg.sample_rate + cfg.frame_tolerance_s
    curr = tuple(x for x in curr if x.end > boundary_s)
    prev = state.prev_hypothesis
    if prev is not None:
        prev = tuple(x for x in prev if x.end > boundary_s)
    frontier = len(state.committed_words)

    veto_prob = veto_edge = False
    commit_n = 0
    if prev is not None and curr:
        agreed = _common_prefix_len(prev, curr)
        # terminal-word guard: eligible only if non-terminal in both hypotheses
        eligible = min(agreed, len(prev) - 1, len(curr) - 1)
        commit_n = 0
        for i in range(max(0, eligible)):
            w = curr[i]
            if w.end > edge_limit_s:
                veto_edge = True
                break
            if w.probability < cfg.word_prob_floor:
                veto_prob = True
                break
            commit_n = i + 1

    holdback_fired = False
    if commit_n > 0:
        new_holdback = (-1, 0)  # frontier advanced — reset (C7.5)
    elif curr:
        # frontier did not advance this tick — run the holdback counter
        if state.holdback_frontier == frontier:
            ticks = state.holdback_ticks + 1
        else:
            ticks = 1
        if ticks >= cfg.max_holdback_ticks:
            # force-commit: newest hypothesis, no agreement, no prob floor —
            # but never past the edge guard (C7.5)
            forced_n = 0
            for w in curr:
                if w.end > edge_limit_s:
                    break
                forced_n += 1
            if forced_n > 0:
                commit_n = forced_n
                holdback_fired = True
                ticks = 0
        new_holdback = (frontier, ticks) if not holdback_fired else (-1, 0)
    else:
        # empty hypothesis: neither advance nor evidence of flip-flop — hold
        new_holdback = (state.holdback_frontier, state.holdback_ticks)

    newly = curr[:commit_n]
    tentative = curr[commit_n:]

    committed_through = state.committed_through_sample
    if newly:
        committed_through = int(round(newly[-1].end * cfg.sample_rate))

    new_state = PolicyState(
        committed_words=state.committed_words + newly,
        committed_through_sample=committed_through,
        prev_hypothesis=curr,
        holdback_frontier=new_holdback[0],
        holdback_ticks=new_holdback[1],
    )
    return CommitDecision(
        newly_committed=newly,
        tentative=tentative,
        holdback_fired=holdback_fired,
        veto_prob=veto_prob,
        veto_edge=veto_edge,
        state=new_state,
    )


def flush(state: PolicyState, final_hyp: tuple[Word, ...]) -> tuple[tuple[Word, ...], PolicyState]:
    """VAD flush (C3.3): silence is ground truth — commit everything remaining.

    No agreement, no vetoes. Returns (newly_committed, reset-for-next-utterance
    state). The flush decode covered the uncommitted buffer only (C5.2), so
    final_hyp cannot contradict previously committed words.
    """
    new_state = PolicyState()  # per-utterance state resets; session clock lives outside
    return final_hyp, new_state


def committed_text(words: tuple[Word, ...]) -> str:
    return " ".join(w.text for w in words)
