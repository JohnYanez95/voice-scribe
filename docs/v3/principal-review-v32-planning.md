# Principal Review — v3.2 Planning Handoff

**Date:** 2026-04-05
**From:** Principal Reviewer
**To:** PM
**Re:** v3.1 gate closure, v3.2 scope change, and consolidated open items

---

## v3.1 Gate — Closed

All three roadmap gate criteria verified on 2026-04-05:

| Verification | Context | Result |
|---|---|---|
| Dictate → say "copy" → paste in Discord | Desktop (Tauri) | Pass |
| Dictate → Ctrl+Shift+Y → paste in Discord | Desktop (Tauri) | Pass |
| Dictate → Ctrl+Shift+Y → paste | Browser (Chrome) | Pass |
| npx vitest run | 84/84 | Pass |
| python -m pytest tests/ -v | 41/41 | Pass |
| npm run build | 71 modules, zero errors | Pass |
| npx tsc --noEmit | Clean | Pass |

125 automated tests green. The only fix required was a one-line CSP restoration in `tauri.conf.json` — adding `http://127.0.0.1:8001` to `connect-src`. This entry had been reverted during unrelated Record stall debugging (WSL2 audio loss) and was never restored.

**Observation:** A `NeedDebuggerBreak` trap appeared during continuous-mode dictation, before clipboard testing. App survived — no crash, no lost state. Did not recur. Cause unidentified. Monitoring only; capture terminal output if it recurs.

---

## v3.2 Scope Change — `submit` Dropped

**Decision:** The `submit` voice command (direct keystroke injection into the focused application) is dropped from v3.2.

**Reason:** The development environment runs the Tauri desktop app inside WSL2 (Linux/WebKitGTK). `SendInput` is a Win32 API with no path into WSL2's Linux process namespace. Implementing `submit` would require either a full Windows-native Tauri build (WebView2, new webview permission model, new triage cycle) or a Windows-side helper process. Both are substantial engineering for a feature that saves one Ctrl+V keystroke.

The clipboard delivery loop already works end-to-end: dictate → say "copy" → switch app → Ctrl+V → transcript is there. WSLg transparently bridges the Linux clipboard (arboard writes via Wayland) to the Windows clipboard. The delivery gap that motivated v3 is closed.

**Disposition:**
- `submit` moves to a named deferral in the roadmap. Trigger: if the project ever moves to a Windows-native build for other reasons (distribution packaging, WebView2 migration), `submit` becomes cheap to add at that point.
- The `submitText()` stub in `platform.ts` can remain — it costs nothing and the routing surface is already tested.
- The `submit` entry in the locked voice command surface (roadmap lines 633–640) should be updated to reflect the deferral.

---

## v3.2 — Proposed New Scope

### Audio Feedback for Voice Commands

User request: audible confirmation when voice commands fire. Currently both `copy` and `clear` execute silently — no feedback that the command was recognized and acted on without checking the clipboard or looking at the textarea.

**Proposed sounds:**
- `copy` success → short chime
- `clear` success → whoosh/sweep

**Hard requirement on timing:** The `copy` chime must play after `writeClipboard()` resolves, not on command detection. A chime followed by a silent clipboard failure is worse than no chime at all. `clear` is synchronous (React state setter) — sound can fire immediately.

**Implementation surface:** Both `case "copy"` and `case "clear"` in `App.tsx` voice command dispatch. Web Audio API or bundled audio files. Small scope — no architectural changes, no backend changes, no new dependencies beyond the sound assets themselves.

### Cleanup Items (Carried from v3.1)

1. **Transcript.tsx clipboard routing.** The "Copy to Clipboard" button calls `navigator.clipboard.writeText()` directly instead of `platform.writeClipboard()`. Functions via `execCommand("copy")` fallback in Tauri but is inconsistent with the two call sites migrated in v3.1. Route through the platform layer.

2. **Clipboard server CORS hardcode.** `main.rs` sends `Access-Control-Allow-Origin: http://localhost:5173`. Correct for dev mode. Will reject clipboard writes from production builds where the origin is `tauri://localhost` or `https://tauri.localhost`. Address when `CARGO_MANIFEST_DIR` → `resource_dir()` transition happens. Same trigger — ship together.

### Possible Addition: Global Hotkeys (was v3.3)

With `submit` dropped, global hotkeys become the next high-impact feature. Recording currently requires focusing the Voice Scribe window first. Global hotkeys (`@tauri-apps/plugin-global-shortcut`) would allow triggering recording from any application.

**Note:** This was previously v3.3 scope. Whether to pull it into v3.2 or keep it as a separate milestone is a PM decision. The engineering dependency is clean — global hotkeys have no dependency on `submit` and no dependency on the cleanup items above. They could be a standalone milestone or bundled.

---

## Documentation Completed This Session

Six items committed across two commits (78ecb0e, 304a106):

1. **CLAUDE.md** — Status advanced from v2.2 to v3.1. Project overview rewritten for both runtime contexts. Desktop shell architecture, platform.ts, HTTP clipboard server, make desktop, Tauri CORS origins, v3 as living deck — all reflected.

2. **v3 deck `platform.ts` slide** — `writeClipboard()` Tauri column updated from clipboard plugin to HTTP POST + arboard.

3. **v3 deck "Why Runtime Detection" slide** — clipboard plugin example replaced; rationale preserved for v3.3 `plugin-global-shortcut`.

4. **Roadmap locked decisions** — `plugin-clipboard-manager` removed, HTTP + arboard named as locked clipboard architecture with Triage #6 pointer.

5. **v2 deck test count** — 70 → 84 frontend tests. Factual correction only; deck remains frozen.

6. **Progress report `cuda_ld_library_path()`** — description updated to cover both venv and user-scope scans, matching the code.

---

## Documentation Still Needed

1. **Roadmap v3.2 scope rewrite.** Current text (lines 777–820) describes `submit` injection as the headline deliverable. Needs full replacement with the new scope: audio feedback, cleanup items, and the `submit` deferral rationale.

2. **v3 presentation deck update.** The deck covers v3.0 and v3.1. New slides needed for whatever v3.2 becomes. Platform.ts architecture bullet, auto-scroll UX bullet, and clipboard architecture bullet are already noted as gaps.

3. **`CARGO_MANIFEST_DIR` rework trigger.** Progress report should note that the compile-time constant bakes the build machine's absolute path into the binary. Distribution packaging must switch to `resource_dir()`.

---

## Open Items (Full Inventory)

| # | Item | Owner | Timing |
|---|---|---|---|
| 1 | Roadmap v3.2 scope rewrite | PM | Before v3.2 implementation |
| 2 | Audio feedback for voice commands | Senior | v3.2 implementation |
| 3 | Transcript.tsx clipboard routing | Senior | v3.2 implementation |
| 4 | Clipboard server CORS hardcode | Senior | When production packaging starts |
| 5 | `submit` deferral in roadmap | PM | Roadmap update |
| 6 | v3 deck update (v3.1 + v3.2 content) | PM | After v3.2 scope is locked |
| 7 | `CARGO_MANIFEST_DIR` rework note | PM | Progress report |
| 8 | v3.0 residual gate items (HTTP fallback, sidecar cleanup) | Senior | Next desktop session |
| 9 | NeedDebuggerBreak monitoring | Senior | Ongoing — capture output if recurs |
| 10 | Global hotkeys sequencing decision | PM | v3.2 planning |

---

## Context for PM

The project is entering a polish phase. The user's primary workflow is shifting toward labeling and annotation rather than building pipelines. Voice Scribe as a dictation primitive is delivering value in its current state. The features being requested — audio feedback, consistency cleanup — are refinements, not capabilities. Scope discipline should reflect this: small milestones, tight gates, no speculative features.
