"""Unit tests for the LocalAgreement commit policy core (docs/v4/protocol.md §7).

Pure functions only — no model, no WebSocket, no threads. Synthetic hypothesis
sequences. Each test names the protocol clause it enforces.
"""
import pytest

from app.services.stream_policy import (
    CommitDecision,
    PolicyConfig,
    PolicyState,
    Word,
    agree,
    committed_text,
    flush,
    localize,
    normalize_token,
    plan_window,
    retention_start_sample,
)

CFG = PolicyConfig()
SR = CFG.sample_rate


def w(text, start, end, prob=0.95):
    return Word(text=text, start=start, end=end, probability=prob)


def hyp(*words):
    return tuple(words)


def sample(seconds: float) -> int:
    return int(seconds * SR)


# ---------------------------------------------------------------------------
# Window invariant — C7.1
# ---------------------------------------------------------------------------

def test_default_config_satisfies_window_invariant():
    CFG.validate()  # 3 + 24 + 3 = 30 — must not raise


def test_window_invariant_rejects_original_28s_proposal():
    """The review-caught bug: 28 s + 3 s left context silently truncates."""
    bad = PolicyConfig(max_uncommitted_s=28.0)
    with pytest.raises(ValueError, match="window invariant"):
        bad.validate()


# ---------------------------------------------------------------------------
# Normalization — C7.3
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("a,b", [
    ("hello,", "hello"),
    ("Hello", "hello."),
    ("HELLO!", "hello"),
    ("“quoted”", "quoted"),
])
def test_normalize_punctuation_and_case_variants_match(a, b):
    assert normalize_token(a) == normalize_token(b)


def test_normalize_keeps_internal_apostrophe_and_hyphen():
    assert normalize_token("don't") == "don't"
    assert normalize_token("re-decode,") == "re-decode"


def test_normalize_distinct_words_stay_distinct():
    assert normalize_token("fox") != normalize_token("box")


# ---------------------------------------------------------------------------
# Agreement — C7.3
# ---------------------------------------------------------------------------

def test_first_tick_commits_nothing():
    """One pass proves nothing — all tentative."""
    d = agree(PolicyState(), hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5)),
              buffer_end_sample=sample(2.0), cfg=CFG)
    assert d.newly_committed == ()
    assert len(d.tentative) == 2


def test_agreement_commits_common_prefix():
    s = PolicyState()
    d1 = agree(s, hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5), w("brown", 0.5, 0.8),
                      w("fo", 0.8, 1.0)),
               buffer_end_sample=sample(2.0), cfg=CFG)
    d2 = agree(d1.state,
               hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5), w("brown", 0.5, 0.8),
                   w("fox", 0.8, 1.1), w("jum", 1.1, 1.3)),
               buffer_end_sample=sample(2.75), cfg=CFG)
    assert [x.text for x in d2.newly_committed] == ["the", "quick", "brown"]
    assert [x.text for x in d2.tentative] == ["fox", "jum"]


def test_committed_surface_form_comes_from_newer_hypothesis():
    """C7.3: compare normalized, commit raw-from-newer."""
    s = PolicyState()
    d1 = agree(s, hyp(w("hello,", 0.0, 0.4), w("world", 0.4, 0.8), w("now", 0.8, 1.0)),
               buffer_end_sample=sample(2.0), cfg=CFG)
    d2 = agree(d1.state,
               hyp(w("Hello", 0.0, 0.4), w("world", 0.4, 0.8), w("now", 0.8, 1.0),
                   w("then", 1.0, 1.2)),
               buffer_end_sample=sample(2.5), cfg=CFG)
    assert d2.newly_committed[0].text == "Hello"  # newer surface form


def test_terminal_word_never_commits_even_when_agreed():
    """C7.3 terminal guard: punctuation churn lives on the terminal word."""
    s = PolicyState()
    d1 = agree(s, hyp(w("stop", 0.0, 0.4)), buffer_end_sample=sample(2.0), cfg=CFG)
    d2 = agree(d1.state, hyp(w("stop", 0.0, 0.4)), buffer_end_sample=sample(2.75), cfg=CFG)
    assert d2.newly_committed == ()  # agreed, but terminal in both


def test_disagreement_commits_nothing_past_divergence():
    s = PolicyState()
    d1 = agree(s, hyp(w("the", 0.0, 0.2), w("fast", 0.2, 0.5), w("car", 0.5, 0.8)),
               buffer_end_sample=sample(2.0), cfg=CFG)
    d2 = agree(d1.state,
               hyp(w("the", 0.0, 0.2), w("vast", 0.2, 0.5), w("car", 0.5, 0.8),
                   w("went", 0.8, 1.0)),
               buffer_end_sample=sample(2.75), cfg=CFG)
    assert [x.text for x in d2.newly_committed] == ["the"]


# ---------------------------------------------------------------------------
# Vetoes — C7.4 (withhold-only)
# ---------------------------------------------------------------------------

def test_word_prob_floor_withholds_agreed_word_and_suffix():
    s = PolicyState()
    words1 = hyp(w("alpha", 0.0, 0.3), w("beta", 0.3, 0.6, prob=0.3), w("gamma", 0.6, 0.9),
                 w("tail", 0.9, 1.1))
    d1 = agree(s, words1, buffer_end_sample=sample(3.0), cfg=CFG)
    d2 = agree(d1.state, words1, buffer_end_sample=sample(3.75), cfg=CFG)
    assert [x.text for x in d2.newly_committed] == ["alpha"]
    assert d2.veto_prob


def test_edge_guard_withholds_words_near_buffer_end():
    """C7.4: never commit a word ending within EDGE_GUARD_S of the buffer end."""
    s = PolicyState()
    words = hyp(w("safe", 0.0, 0.3), w("edgy", 1.55, 1.9), w("tail", 1.9, 2.0))
    d1 = agree(s, words, buffer_end_sample=sample(2.0), cfg=CFG)
    d2 = agree(d1.state, words, buffer_end_sample=sample(2.0), cfg=CFG)
    # edge limit = 2.0 - 0.6 = 1.4; "edgy" ends at 1.9 > 1.4 → withheld
    assert [x.text for x in d2.newly_committed] == ["safe"]
    assert d2.veto_edge


def test_vetoes_never_revise_previously_committed_text():
    """C5.5: withhold affects only new commits; committed words are untouched."""
    s = PolicyState(committed_words=(w("done", 0.0, 0.5),),
                    committed_through_sample=sample(0.5))
    d = agree(s, hyp(w("junk", 0.5, 0.8, prob=0.1), w("tail", 0.8, 1.0)),
              buffer_end_sample=sample(2.0), cfg=CFG)
    assert d.state.committed_words[0].text == "done"


# ---------------------------------------------------------------------------
# Holdback — C7.5 (frontier-anchored)
# ---------------------------------------------------------------------------

def _flip_flop_tick(state, variant, end=3.0):
    """A-B-A-B alternation at the frontier: normalized keys genuinely differ."""
    return agree(state, hyp(w(variant, 0.0, 0.4), w("tail", 0.4, 0.8)),
                 buffer_end_sample=sample(end), cfg=CFG)


def test_flip_flop_fires_holdback_and_commits_newest():
    s = PolicyState()
    d = _flip_flop_tick(s, "aaa")
    for i in range(CFG.max_holdback_ticks):
        d = _flip_flop_tick(d.state, "aaa" if i % 2 else "bbb")
        if d.holdback_fired:
            break
    assert d.holdback_fired
    assert len(d.newly_committed) >= 1  # newest hypothesis committed


def test_holdback_counter_resets_when_frontier_advances():
    """C7.5: reset only on frontier advance — a changed-hypothesis reset starves."""
    s = PolicyState()
    d = _flip_flop_tick(s, "aaa")
    d = _flip_flop_tick(d.state, "bbb")
    assert d.state.holdback_ticks > 0
    # now agree twice → frontier advances → counter resets
    stable = hyp(w("ccc", 0.0, 0.4), w("ddd", 0.4, 0.8), w("tail", 0.8, 1.2))
    d = agree(d.state, stable, buffer_end_sample=sample(3.0), cfg=CFG)
    d = agree(d.state, stable, buffer_end_sample=sample(3.0), cfg=CFG)
    assert len(d.newly_committed) > 0
    assert d.state.holdback_ticks == 0


def test_holdback_respects_edge_guard():
    """Force-commit bypasses agreement and the prob floor — never the edge guard."""
    s = PolicyState()
    d = agree(s, hyp(w("aaa", 2.6, 2.9)), buffer_end_sample=sample(3.0), cfg=CFG)
    for i in range(CFG.max_holdback_ticks + 2):
        d = agree(d.state, hyp(w("aaa" if i % 2 else "bbb", 2.6, 2.9)),
                  buffer_end_sample=sample(3.0), cfg=CFG)
    # word ends at 2.9 > 3.0 - 0.6 = 2.4 → inside the guard → never committed
    assert d.state.committed_words == ()


def test_empty_hypothesis_neither_advances_nor_counts_flip_flop():
    s = PolicyState()
    d = _flip_flop_tick(s, "aaa")
    d = _flip_flop_tick(d.state, "bbb")
    ticks_before = d.state.holdback_ticks
    d = agree(d.state, hyp(), buffer_end_sample=sample(3.0), cfg=CFG)
    assert d.state.holdback_ticks == ticks_before
    assert d.newly_committed == ()


# ---------------------------------------------------------------------------
# Window planning + trim arithmetic — C7.1, C7.2, C5.6
# ---------------------------------------------------------------------------

def test_plan_window_starts_at_zero_early_in_utterance():
    p = plan_window(0, sample(2.0), CFG)
    assert p.window_start_sample == 0
    assert p.overflow_drop_samples == 0


def test_plan_window_carries_left_context_after_commit():
    committed = sample(10.0)
    p = plan_window(committed, sample(12.0), CFG)
    assert p.window_start_sample == committed - sample(CFG.left_context_s)
    assert p.context_end_sample == committed


def test_plan_window_reports_overflow_oldest_first():
    """C5.6: overflow drops the OLDEST uncommitted audio, reported not silent."""
    committed = sample(1.0)
    total = sample(1.0 + CFG.max_uncommitted_s + 2.0)  # 2 s over the cap
    p = plan_window(committed, total, CFG)
    assert p.overflow_drop_samples == sample(2.0)
    assert p.context_end_sample == committed + sample(2.0)


def test_planned_window_never_exceeds_whisper_30s():
    committed = sample(100.0)
    total = sample(100.0 + CFG.max_uncommitted_s)
    p = plan_window(committed, total, CFG)
    window_s = (total - p.window_start_sample) / SR
    assert window_s <= 30.0 - CFG.safety_s + CFG.left_context_s  # 27 s planned


def test_retention_start_keeps_left_context_only():
    assert retention_start_sample(sample(10.0), CFG) == sample(7.0)
    assert retention_start_sample(sample(1.0), CFG) == 0


# ---------------------------------------------------------------------------
# Left-context suppression — C7.2 (by timestamp, never string matching)
# ---------------------------------------------------------------------------

def test_localize_suppresses_words_inside_left_context():
    # window starts at 7 s abs; committed boundary at 10 s abs
    words = [("old", 0.5, 2.9, 0.9), ("boundary", 2.9, 3.0, 0.9), ("new", 3.0, 3.4, 0.9)]
    out = localize(words, sample(7.0), sample(10.0), CFG)
    # "old" ends 9.9 ≤ 10 → suppressed; "boundary" ends exactly 10.0 → suppressed
    assert [x.text for x in out] == ["new"]
    assert out[0].start == pytest.approx(10.0)


def test_localize_keeps_word_straddling_the_boundary():
    """A word starting inside context but ending past it carries new content."""
    words = [("straddle", 2.8, 3.3, 0.9)]
    out = localize(words, sample(7.0), sample(10.0), CFG)
    assert [x.text for x in out] == ["straddle"]
    assert out[0].end == pytest.approx(10.3)


def test_localize_returns_absolute_coordinates():
    """C7.2: hypotheses from different window positions must align."""
    words = [("word", 1.0, 1.5, 0.9)]
    out_a = localize(words, sample(0.0), sample(0.0), CFG)
    out_b = localize(words, sample(5.0), sample(5.0), CFG)
    assert out_a[0].start == pytest.approx(1.0)
    assert out_b[0].start == pytest.approx(6.0)


def test_agreement_survives_buffer_slide():
    """Same audio decoded from two window positions still agrees (C7.2)."""
    s = PolicyState(committed_words=(w("prior", 0.0, 6.0),),
                    committed_through_sample=sample(6.0))
    # tick k: window starts at 3 s (6 − left_context)
    hyp_k = localize([("hello", 3.2, 3.6, 0.9), ("world", 3.6, 4.0, 0.9),
                      ("tail", 4.0, 4.4, 0.9)],
                     sample(3.0), sample(6.0), CFG)
    d1 = agree(s, hyp_k, buffer_end_sample=sample(8.0), cfg=CFG)
    # tick k+1: suppose more commits moved the window — same words, new frame
    hyp_k1 = localize([("hello", 0.2, 0.6, 0.9), ("world", 0.6, 1.0, 0.9),
                       ("tail", 1.0, 1.4, 0.9), ("more", 1.4, 1.8, 0.9)],
                      sample(6.0), sample(6.0), CFG)
    d2 = agree(d1.state, hyp_k1, buffer_end_sample=sample(8.5), cfg=CFG)
    assert [x.text for x in d2.newly_committed] == ["hello", "world"]


# ---------------------------------------------------------------------------
# Flush — C3.3, C5.2
# ---------------------------------------------------------------------------

def test_flush_commits_everything_no_agreement_needed():
    state = PolicyState(committed_words=(w("already", 0.0, 0.5),),
                        committed_through_sample=sample(0.5))
    final_words, new_state = flush(state, hyp(w("rest", 0.5, 0.9), w("done", 0.9, 1.2)))
    assert [x.text for x in final_words] == ["rest", "done"]
    assert new_state == PolicyState()  # per-utterance state reset


def test_flush_resets_holdback_and_prev_hypothesis():
    state = PolicyState(prev_hypothesis=hyp(w("x", 0.0, 0.1)),
                        holdback_frontier=0, holdback_ticks=3)
    _, new_state = flush(state, hyp())
    assert new_state.prev_hypothesis is None
    assert new_state.holdback_ticks == 0


# ---------------------------------------------------------------------------
# Zero-retraction invariant — C5.1 (append-only committed state)
# ---------------------------------------------------------------------------

def test_committed_words_are_append_only_across_a_full_scenario():
    """Replay a multi-tick scenario; committed_text must only ever extend."""
    seqs = [
        hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5)),
        hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5), w("brown", 0.5, 0.8)),
        hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5), w("brown", 0.5, 0.8),
            w("fox", 0.8, 1.1)),
        hyp(w("the", 0.0, 0.2), w("quick", 0.2, 0.5), w("brown", 0.5, 0.8),
            w("fox", 0.8, 1.1), w("jumps", 1.1, 1.4)),
    ]
    state = PolicyState()
    prev_text = ""
    for i, s in enumerate(seqs):
        d = agree(state, s, buffer_end_sample=sample(2.0 + i), cfg=CFG)
        state = d.state
        text = committed_text(state.committed_words)
        assert text.startswith(prev_text), f"retraction at tick {i}: {prev_text!r} → {text!r}"
        prev_text = text
    assert prev_text.startswith("the quick brown")
