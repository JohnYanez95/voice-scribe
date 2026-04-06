# PM Response — v3.2 Planning Handoff

**Date:** 2026-04-05
**From:** PM
**To:** Principal Reviewer
**Re:** Response to v3.1 gate closure, v3.2 scope change, and consolidated open items

---

## v3.1 Gate — Acknowledged

Clean closure. No concerns on the verification or the CSP fix characterization.

---

## submit Deferral — Concur

The rationale is correct: the Tauri app runs inside WSL2 (Linux/WebKitGTK), `SendInput` is Win32 with no path into that namespace, and the two alternatives (Windows-native build, Windows-side helper) are substantial engineering for marginal value. The delivery gap that motivated v3 is closed — the clipboard loop works end-to-end without focus.

This is a scope decision I'll enforce going forward. The deferral trigger is clear: if a Windows-native build happens for other reasons, `submit` becomes cheap to add. Until then, it stays deferred.

Roadmap updated in three places: v3.2 scope section (submit removed, audio feedback is headline), the locked voice command surface (submit annotated as deferred), and the v3 deferred list (submit added with rationale and trigger).

---

## v3.2 Scope — Accepted with One Sequencing Decision

**Audio feedback: accepted as v3.2 headline.** The timing hard requirement — copy chime plays after `writeClipboard()` resolves, not on command detection — is promoted to a gate criterion. A chime followed by a silent clipboard failure is worse than no chime.

**Cleanup items: accepted.**

- Transcript.tsx clipboard routing is consistency debt carried from v3.1. Execution is straightforward — route through `platform.writeClipboard()`, verify `execCommand("copy")` fallback is no longer needed, update the progress report's "2 of 3 call sites" note.
- Clipboard server CORS hardcode remains scoped to the `CARGO_MANIFEST_DIR` → `resource_dir()` production packaging transition. No change from prior disposition.

**Global hotkeys: keep as v3.3.** Audio feedback + cleanup is a tight milestone with no architectural risk. Global hotkeys introduce a new Tauri plugin (`@tauri-apps/plugin-global-shortcut`), system-level shortcut registration, and potential conflicts with OS-reserved bindings — a distinct triage surface. Bundling them into v3.2 inflates scope and creates a mixed gate (polish items plus a new capability). Better as a standalone milestone.

v3.2 gate will verify: both sounds play at the correct moment (copy after clipboard write resolves, clear immediately), silence on clipboard failure, all three clipboard call sites route through `platform.writeClipboard()`, browser build still clean.

---

## Documentation — Ownership and Disposition

| # | Item | Owner | Action |
|---|---|---|---|
| 1 | Roadmap v3.2 scope rewrite | PM | Done — committed with this response |
| 2 | Audio feedback implementation | Senior | v3.2 implementation |
| 3 | Transcript.tsx clipboard routing | Senior | v3.2 implementation |
| 4 | Clipboard server CORS hardcode | Senior | When production packaging starts |
| 5 | submit deferral in roadmap | PM | Done — folded into v3.2 scope rewrite |
| 6 | v3 deck update | PM | After v3.2 ships |
| 7 | CARGO_MANIFEST_DIR rework note | — | Dropped. Existing progress report paragraph (line 258) is sufficient. No duplicate entry. |
| 8 | v3.0 residual gate items | Senior | Testing gap. Run HTTP fallback and sidecar cleanup check at next `make desktop` session. Note results in progress report. Does not block v3.2. |
| 9 | NeedDebuggerBreak monitoring | Senior | Ongoing — capture terminal output if recurs |
| 10 | Global hotkeys sequencing | PM | v3.3 — rationale above |

---

## Forward Sequence

1. Roadmap v3.2 scope rewrite is committed with this response. Engineer can begin implementation.
2. Engineer runs v3.0 residual checks (HTTP fallback, sidecar cleanup) at the next desktop session. Results go in the progress report.
3. I update the v3 deck after v3.2 ships.
