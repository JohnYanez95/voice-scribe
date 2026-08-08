# Documentation map

Four milestones of documents live here. This page says which are current, which
are frozen snapshots, and which are working notes — so you can tell at a glance
whether what you're reading is a specification or a lab notebook.

## Current — maintained, authoritative

| Document | What it is |
| --- | --- |
| [`contract/runtime-contract.md`](contract/runtime-contract.md) | The stable interface for downstream consumers: request/response shapes, hard limits, privacy guarantees. Changes here require regenerating `runtime-contract.schema.json`; a drift test fails CI if you forget. |
| [`v4/protocol.md`](v4/protocol.md) | The `/ws/stream` streaming wire protocol, specified in numbered clauses (C1.1, C7.14, …). Session tests cite the clause they enforce. Amendments are dated and carry the review that produced them. |
| [`v4/policy-guide/main.pdf`](v4/policy-guide/) | The commit policy explained by intuition: every tuning parameter drawn as the failure it prevents versus the behavior it buys. |
| [`privacy.md`](privacy.md) | Data flow, what is and isn't logged, and the opt-in diagnostic modes that can capture content locally. |
| [`threat-model.md`](threat-model.md) | Assets, trust boundaries, accepted risks. |
| [`references.md`](references.md) | The papers behind the model and the commit policy, with citations — and a statement of what in the streaming design is original here and what is not. |
| [`docker-setup.md`](docker-setup.md) · [`v3/host-setup.md`](v3/host-setup.md) | Getting a GPU environment working (Docker; bare-host sidecar). |

## Working documents — internal, not specifications

| Document | What it is |
| --- | --- |
| [`../roadmap.md`](../roadmap.md) | The decision log. Scope calls, measured results, hypotheses that were retired by evidence, and the reviews behind each milestone gate. It is the source of truth for *why* the software is shaped this way — and it is a working notebook, not documentation. |
| [`v4/field-test.md`](v4/field-test.md) | The runbook for measuring a release against live dictation, plus the committed `field-test-report-*.json` counter sets from each run. |

## Frozen — historical snapshots

`v1/`, `v2/`, `v3/` hold delivery reports, sign-off records, and presentation
decks describing the system **as it stood at that milestone**. They are not
maintained and will contradict current behavior in places; that is intentional —
they are the record of what was true then. `v3/presentation/main.tex` is the one
living deck (onboarding), per `CLAUDE.md`.

## Reading order for a newcomer

1. The repository [`README.md`](../README.md) — what it is and how to run it.
2. [`contract/runtime-contract.md`](contract/runtime-contract.md) — the boundary you'd build against.
3. [`v4/protocol.md`](v4/protocol.md) §5 and §7 — the invariants that make committed text safe to act on.
4. [`v4/policy-guide/main.pdf`](v4/policy-guide/) — the same policy, drawn rather than specified.
