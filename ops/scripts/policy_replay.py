#!/usr/bin/env python3
"""Offline replay of the LocalAgreement commit policy from a C9.3 trace.

Consumes a stream-trace JSONL (server started with STREAM_TRACE_DIR set),
re-runs the pure policy functions over the recorded per-tick hypotheses, and
reports commit decisions — turning tunable and surface-form questions into
millisecond replays instead of GPU sweeps.

OUTPUT CONTAINS TRANSCRIPT TEXT by design: this is an operator tool consuming
an operator-opt-in trace. Never commit its output; keep it in gitignored paths.

Usage:
  python ops/scripts/policy_replay.py TRACE.jsonl
      [--set KEY=VALUE ...]     PolicyConfig overrides (word_prob_floor=0.4)
      [--surface curr|prev]     committed surface-form source (default curr =
                                shipped behavior; prev = candidate C7.3 change)
      [--utterance N]           restrict to one utterance
      [--ticks A:B]             restrict to a tick_index range
      [--from-raw]              recompute localize() from words_raw instead of
                                using the recorded localized hyp
      [--reference REF.json]    {"<utterance_id>": "one-shot raw text"} — adds
                                surface-vs-reference classification
      [--verify]                assert the replay reproduces recorded commit_n
                                per tick; exit 1 on drift
      [--json OUT.json]         machine-readable summary
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

from app.services.stream_policy import (  # noqa: E402
    PolicyConfig,
    PolicyState,
    Word,
    agree,
    committed_text,
    flush as policy_flush,
    localize,
    normalize_token,
)


def words_from(rec_list: list) -> tuple[Word, ...]:
    return tuple(Word(text=t, start=s, end=e, probability=p)
                 for t, s, e, p in rec_list)


def classify_against_reference(prev_text: str, curr_text: str,
                               ref_tokens: list[str]) -> str:
    """Best-effort: find the normalized match in the reference and compare
    surfaces. 'prev_correct' = prev carries the reference's punctuation/case
    where curr does not; 'prev_spurious' = the reverse; else 'neutral'."""
    key = normalize_token(curr_text)
    matches = [t for t in ref_tokens if normalize_token(t) == key]
    if not matches:
        return "unmatched"
    ref = matches[0]
    if prev_text == ref and curr_text != ref:
        return "prev_correct"
    if curr_text == ref and prev_text != ref:
        return "prev_spurious"
    return "neutral"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trace")
    ap.add_argument("--set", dest="overrides", action="append", default=[])
    ap.add_argument("--surface", choices=["curr", "prev"], default="curr")
    ap.add_argument("--utterance", type=int)
    ap.add_argument("--ticks")
    ap.add_argument("--from-raw", action="store_true")
    ap.add_argument("--reference")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    records = [json.loads(line) for line in Path(args.trace).read_text().splitlines()]
    header = records[0]
    if header.get("kind") != "session":
        raise SystemExit("trace has no session header record")

    cfg_dict = dict(header["policy_config"])
    for pair in args.overrides:
        key, _, value = pair.partition("=")
        if key not in cfg_dict:
            raise SystemExit(f"unknown PolicyConfig field {key!r}")
        cfg_dict[key] = type(cfg_dict[key])(value) if not isinstance(cfg_dict[key], int) \
            else int(value)
    cfg = PolicyConfig(**cfg_dict)

    references = {}
    if args.reference:
        references = {int(k): v for k, v in
                      json.loads(Path(args.reference).read_text()).items()}

    tick_lo, tick_hi = None, None
    if args.ticks:
        lo, _, hi = args.ticks.partition(":")
        tick_lo, tick_hi = (int(lo) if lo else None), (int(hi) if hi else None)

    state = PolicyState()
    prev_hyp: tuple[Word, ...] | None = None
    current_utt = None
    drift = 0
    rows = []
    surface_events = []
    utterance_texts: dict[int, list[str]] = {}

    for rec in records[1:]:
        utt = rec.get("utterance_id")
        if args.utterance is not None and utt != args.utterance:
            continue
        if rec["kind"] == "tick":
            idx = rec.get("tick_index")
            if tick_lo is not None and idx is not None and idx < tick_lo:
                continue
            if tick_hi is not None and idx is not None and idx > tick_hi:
                continue
            if current_utt != utt:
                state, prev_hyp, current_utt = PolicyState(), None, utt
            if args.from_raw:
                hyp = localize([tuple(x) for x in rec["words_raw"]],
                               rec["window_start_sample"],
                               rec["context_end_sample"], cfg)
            else:
                hyp = words_from(rec["hyp"])
            before_prev = state.prev_hypothesis
            decision = agree(state, hyp, rec["decoded_end_sample"], cfg,
                             alignment_boundary_sample=rec["context_end_sample"])
            state = decision.state
            committed = list(decision.newly_committed)
            if (args.surface == "prev" and committed and not decision.holdback_fired
                    and before_prev is not None):
                # candidate C7.3 change: prev surface, curr timings — align by
                # re-filtering prev at the same boundary agree() used
                prev_f = tuple(x for x in before_prev
                               if x.end > rec["context_end_sample"] / cfg.sample_rate
                               + cfg.frame_tolerance_s)
                for i, w in enumerate(committed):
                    if i < len(prev_f) and prev_f[i].text != w.text:
                        cls = None
                        if utt in references:
                            cls = classify_against_reference(
                                prev_f[i].text, w.text,
                                references[utt].split())
                        surface_events.append({
                            "utterance_id": utt, "tick_index": idx,
                            "curr": w.text, "prev": prev_f[i].text,
                            "class": cls,
                        })
                        committed[i] = Word(text=prev_f[i].text, start=w.start,
                                            end=w.end, probability=w.probability)
            utterance_texts.setdefault(utt, []).extend(w.text for w in committed)
            recorded_n = rec.get("commit_n")
            replay_n = len(decision.newly_committed)
            if args.verify and args.surface == "curr" and not args.overrides \
                    and recorded_n is not None and recorded_n != replay_n:
                drift += 1
            rows.append({
                "utterance_id": utt, "tick_index": idx,
                "recorded_commit_n": recorded_n, "replay_commit_n": replay_n,
                "agreed_n": decision.agreed_n, "eligible_n": decision.eligible_n,
                "veto_prob": decision.veto_prob, "veto_edge": decision.veto_edge,
                "holdback_fired": decision.holdback_fired,
                "holdback_ticks": state.holdback_ticks,
                "residue_suppressed": decision.residue_suppressed,
                "committed": " ".join(w.text for w in committed),
            })
        elif rec["kind"] == "flush":
            tail = words_from([[t, 0.0, 0.0, 1.0] for t in rec["tail_committed"]]) \
                if rec.get("tail_committed") else ()
            newly, state = policy_flush(state, tail)
            utterance_texts.setdefault(utt, []).extend(w.text for w in newly)
            prev_hyp, current_utt = None, None

    for row in rows:
        flags = "".join([
            "E" if row["veto_edge"] else "-",
            "P" if row["veto_prob"] else "-",
            "H" if row["holdback_fired"] else "-",
            "R" if row["residue_suppressed"] else "-",
        ])
        print(f"u{row['utterance_id']:>3} t{str(row['tick_index']):>5} "
              f"rec={row['recorded_commit_n']} rep={row['replay_commit_n']} "
              f"agreed={row['agreed_n']} elig={row['eligible_n']} [{flags}] "
              f"| {row['committed']}")

    summary = {
        "ticks_replayed": len(rows),
        "verify_drift": drift,
        "surface_mode": args.surface,
        "surface_diff_events": len(surface_events),
        "surface_classes": {
            c: sum(1 for e in surface_events if e["class"] == c)
            for c in ("prev_correct", "prev_spurious", "neutral", "unmatched", None)
            if any(e["class"] == c for e in surface_events)
        },
        "utterance_texts": {str(k): " ".join(v) for k, v in utterance_texts.items()},
        "surface_events": surface_events,
    }
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(summary, indent=2))
    print(f"\nticks={summary['ticks_replayed']} drift={drift} "
          f"surface_diffs={len(surface_events)} "
          f"classes={summary['surface_classes']}")
    if args.verify and drift:
        print("VERIFY FAILED: replay did not reproduce recorded commit_n", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
