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
    # Flush left context (C7.12): the flush decode opens this far before the
    # commit frontier so localize() has a real boundary to suppress against.
    # Deliberately smaller than left_context_s — the flush decode is the
    # finalization-latency path, and every second here is paid there.
    flush_left_context_s: float = 1.0
    # Seam-suppressor bound (C7.12): a flush-tail leading word matching the
    # last committed word is treated as frontier residue only if it starts
    # within this of the frontier. The DTW word-end error that creates the
    # residue is tens of ms; a genuine repeat spoken later in the tail starts
    # well past this and is never touched.
    seam_tolerance_s: float = 0.10
    # Tick-residue bound (C7.13): a tick-path residue is a properly-timed
    # re-decode whose END drifted just past the frontier — a genuine repeat
    # ends a full word-duration later. Gated on the end, not the start (the
    # flush seam's start gate never fires here: residue starts a whole word
    # before the frontier).
    tick_residue_tolerance_s: float = 0.20

    def validate(self) -> None:
        """Window invariant (C7.1): pad_or_trim silently truncates past 30 s."""
        total = self.left_context_s + self.max_uncommitted_s + self.safety_s
        if total > 30.0:
            raise ValueError(
                f"window invariant violated: left_context ({self.left_context_s}) + "
                f"max_uncommitted ({self.max_uncommitted_s}) + safety ({self.safety_s}) "
                f"= {total} > 30.0"
            )
        if self.flush_left_context_s > self.left_context_s:
            # Retention only guarantees left_context_s before the frontier
            # (retention_start_sample); a larger flush context would silently
            # clamp to the buffer base and decode with wrong-length context.
            raise ValueError(
                f"flush_left_context_s ({self.flush_left_context_s}) exceeds "
                f"left_context_s ({self.left_context_s}) — retained audio cannot cover it"
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
    residue_suppressed: bool = False  # C7.13 — tick-path frontier residue dropped
    # Stall diagnostics (2026-08-04 review): why commit_n was 0 on a compared
    # tick — the session classifies these into close-line counters (C9.2-safe).
    agreed_n: int = 0    # length of the normalized common prefix
    eligible_n: int = 0  # agreed minus the terminal-word guard, floored at 0


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


def merge_glued_words(
    raw_words: list[tuple[str, float, float, float]],
) -> list[tuple[str, float, float, float]]:
    """Decoder-edge token merge (C7.14).

    faster-whisper marks word-initial tokens with a leading space and emits
    glued continuations (hyphenated suffixes, percent signs, digit groups)
    without one: " K", "-fold", " 95", "%". Committing fragments separately
    and re-joining with spaces fabricates "K -fold" / "95 %" — 2026-08-04
    field finding: 9 artifact tokens in 412 words, each scoring ~2 WER errors
    against the space-preserving one-shot reference. Merging at the decoder
    edge makes each cluster one Word, so a commit boundary can never split it
    and every downstream space-join is correct by construction.

    A fragment starting with whitespace begins a new word; anything else glues
    onto the previous word (concatenated text; span = first start → last end;
    probability = min — conservative for the C7.4 floor). A leading fragment
    without the space marker stands alone. Whitespace-only fragments drop.
    """
    out: list[tuple[str, float, float, float]] = []
    for text, start, end, prob in raw_words:
        if not text.strip():
            continue
        if out and not text[:1].isspace():
            ptext, pstart, _pend, pprob = out[-1]
            out[-1] = (ptext + text, pstart, end, min(pprob, prob))
        else:
            out.append((text, start, end, prob))
    return out


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


def suppress_tick_residue(
    committed: tuple[Word, ...],
    curr: tuple[Word, ...],
    frontier_sample: int,
    cfg: PolicyConfig,
) -> tuple[tuple[Word, ...], bool]:
    """Tick-path frontier residue guard (C7.13).

    A re-decode from a shifted window can re-time the last committed word's
    end past the frontier by more than frame_tolerance_s; it then survives
    the boundary filter, misaligns the prefix comparison against prev (one
    stalled tick), and commits again on the following tick — or immediately
    via holdback force-commit (2026-08-02 live long-form finding: mid-sentence
    "and and", "matter matter" under tick degradation). Same conjunctive shape
    as the C7.12 flush guard but END-gated: the residue is a properly-timed
    word whose end sits just past the frontier, while a genuine immediate
    repeat ends a full word-duration later. Applied to curr only — prev is
    stored post-suppression, so residue never enters it.
    """
    if not committed or not curr:
        return curr, False
    lead = curr[0]
    key = normalize_token(lead.text)
    if not key or key != normalize_token(committed[-1].text):
        return curr, False
    if lead.end > frontier_sample / cfg.sample_rate + cfg.tick_residue_tolerance_s:
        return curr, False
    return curr[1:], True


def agree(
    state: PolicyState,
    curr: tuple[Word, ...],
    buffer_end_sample: int,
    cfg: PolicyConfig,
    alignment_boundary_sample: int | None = None,
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

    alignment_boundary_sample (C7.13 correction, 2026-08-02): the caller's
    localize() boundary — plan.context_end_sample, which is committed_through
    PLUS overflow. Both hypotheses must be filtered at the coordinate localize
    used: filtering at the stale committed_through while overflow > 0 left
    prev carrying words whose audio was dropped, so _common_prefix_len
    compared different words and agreement returned 0 structurally for as
    long as the overflow persisted — the stall latch behind the 2026-08-02
    27 s pinned windows. Words behind the effective edge will never commit;
    they must not participate in the comparison either.
    """
    buffer_end_s = buffer_end_sample / cfg.sample_rate
    edge_limit_s = buffer_end_s - cfg.edge_guard_s

    # Align both hypotheses to the effective committed boundary (C5.1/C7.13):
    # any word ending at or before it is already-committed (or dropped) audio
    # — comparing or re-committing it would duplicate text. This also
    # re-aligns prev when the previous tick committed words out of it.
    frontier_sample = max(
        state.committed_through_sample,
        alignment_boundary_sample if alignment_boundary_sample is not None else 0,
    )
    boundary_s = frontier_sample / cfg.sample_rate + cfg.frame_tolerance_s
    curr = tuple(x for x in curr if x.end > boundary_s)
    # C7.13: drop a frontier residue BEFORE prev is read — this both prevents
    # the duplicate and restores prefix alignment on the same tick. The
    # holdback force-commit below iterates the suppressed curr, so it
    # inherits the guard.
    curr, residue_suppressed = suppress_tick_residue(
        state.committed_words, curr, frontier_sample, cfg
    )
    prev = state.prev_hypothesis
    if prev is not None:
        prev = tuple(x for x in prev if x.end > boundary_s)
    frontier = len(state.committed_words)

    veto_prob = veto_edge = False
    commit_n = 0
    agreed_n = eligible_n = 0
    if prev is not None and curr:
        agreed = _common_prefix_len(prev, curr)
        # terminal-word guard: eligible only if non-terminal in both hypotheses
        eligible = min(agreed, len(prev) - 1, len(curr) - 1)
        agreed_n, eligible_n = agreed, max(0, eligible)
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
        residue_suppressed=residue_suppressed,
        agreed_n=agreed_n,
        eligible_n=eligible_n,
    )


def suppress_seam_duplicate(
    committed: tuple[Word, ...],
    tail: tuple[Word, ...],
    frontier_sample: int,
    cfg: PolicyConfig,
) -> tuple[tuple[Word, ...], bool]:
    """Flush-seam duplicate guard (C7.12).

    The commit frontier is a DTW word-end estimate that routinely lands tens
    of ms early, so the flush window can open on the acoustic residue of the
    last committed word — which a context-free decode re-emits sentence-
    initial ("very Very", 2026-08-02 field finding). The guard is a four-way
    conjunction, each part bounding a specific false-positive:
      1. only the LEADING tail word is eligible (nothing else is seam residue),
      2. normalize_token equality with the last committed word (the existing
         commit key — case/punctuation drift comes free),
      3. the word starts within seam_tolerance_s of the frontier (a genuine
         repeat spoken after a pause starts later and is never touched),
      4. at most one word per flush (the observed artifact is always single).
    Returns (possibly-trimmed tail, suppressed?). Accepted residual risk: a
    genuine immediate repeat whose second copy starts inside the tolerance is
    indistinguishable by any local rule and is dropped; suppressions are
    counted on the session-close line so the trade stays observable.
    """
    if not committed or not tail:
        return tail, False
    lead = tail[0]
    key = normalize_token(lead.text)
    if not key or key != normalize_token(committed[-1].text):
        return tail, False
    frontier_s = frontier_sample / cfg.sample_rate
    if lead.start > frontier_s + cfg.seam_tolerance_s:
        return tail, False
    return tail[1:], True


def flush(state: PolicyState, final_hyp: tuple[Word, ...]) -> tuple[tuple[Word, ...], PolicyState]:
    """VAD flush (C3.3): silence is ground truth — commit everything remaining.

    No agreement, no word-level vetoes. Returns (newly_committed,
    reset-for-next-utterance state). The flush decode re-covers bounded left
    context past the frontier (C7.12); the caller localizes against the
    frontier and applies suppress_seam_duplicate() before committing, so
    final_hyp extends — never contradicts — previously committed words.
    """
    new_state = PolicyState()  # per-utterance state resets; session clock lives outside
    return final_hyp, new_state


def committed_text(words: tuple[Word, ...]) -> str:
    return " ".join(w.text for w in words)
