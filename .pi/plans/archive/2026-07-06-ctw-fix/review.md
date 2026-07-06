# Code Review: CTW Dynamic Update — Recheck

**Reviewed:** Revised approach at `.pi/plans/2026-07-06-ctw-fix/approach.md`
**Verdict:** APPROVED

## Summary

P0.1 from previous review is confirmed fixed. The revised approach correctly uses `syncContextWindow(model, ref, registry)` (direct model parameter) at all call sites, not `context.model`. No new P0 issues found. Approach is ready for detailed planning.

---

## Findings

### P0.1 ✅ FIXED — routeStream call sites use `model` parameter

**Previous issue:** `syncContextWindow(context, syncRef, registry)` where `context` is pi-ai `Context` (no `.model` property) → silent no-op.

**Now:** All three call sites use `model` directly:
- **§3a catch block:** `syncContextWindow(model, syncRef, registry)` — `model` is `Model<Api>`, same ref as `agent.state.model`. Confirmed accessible inside the catch block scope (provider.ts:552-576).
- **§3b after tryModel false:** `syncContextWindow(model, syncRef, registry)` — same `model` parameter, same scope (provider.ts:544-545).
- **§3c model_select handler:** `syncContextWindow(model, activeRef, modelRegistry)` — where `model = ctx.model` from `ExtensionContext`, confirmed as same shared reference.

**Fix verified:** The function signature changed from `(ctx: { model: ... }, ref, registry)` to `(model: { contextWindow: number } | null, ref, registry)` — direct model parameter, no intermediate object. ✓

### Scope Analysis — All Variables Accessible at Insertion Points

| Variable | §3a catch block | §3b after tryModel false | Source |
|----------|:---:|:---:|--------|
| `model` | ✅ | ✅ | routeStream parameter, IIFE closure |
| `ref` | ✅ | ✅ | `const ref = candidates[i]`, for loop body |
| `isLast` | ✅ | ✅ | `const isLast = i === candidates.length - 1`, for loop body |
| `candidates` | ✅ | ✅ | IIFE `const` in routeStream body |
| `registry` | ✅ | ✅ | routeStream parameter |
| `i` | ✅ | ✅ | for loop index |

### No New P0 Issues

| Potential Issue | Status | Rationale |
|----------------|--------|-----------|
| Race condition (CTW sync mid-request) | ✅ Safe | `contextWindow` only affects compaction threshold & footer display, not in-flight routing. §7 explicitly addresses this. |
| Reference mismatch after sync | ✅ Propagates | `model` is `Model<Api>` = shallow copy of `agent.state.model`. Direct mutation on a plain `number` property propagates immediately. Previous review confirmed the data flow (footer → `session.getContextUsage()` → `this.model.contextWindow` → `this.agent.state.model`). |
| `candidates[i+1]` OOB | ✅ Guarded | Accessed only when `!isLast` (i.e. `i < candidates.length - 1`) so `i+1` is always valid. |
| `syncContextWindow` after RouterAbortError | ✅ Guarded | Sync is inside `if (!isAbort)` block in catch. Aborted request → no CTW update (no meaningful CTW). |
| `isRateLimited` unavailable in index.ts helper | ✅ Imported | `import { isRateLimited } from './rate-limit-tracker.js'` already present at line 8 of `index.ts`. |
| `modelRegistry` null at model_select | ✅ Guarded | `syncContextWindowForSelectedModel` checks `if (!modelRegistry) return;` before calling `syncContextWindow`. |
| tryModel returns false + catch block double-sync | ✅ Impossible | `tryModel` either returns `false` (no throw) OR throws. Never both. §7 explicitly confirms. |
| Cooldowned next candidate → wrong CTW | ✅ Acceptable | Called out in approach as transient. Corrected on next `turn_start`/`model_select`. |

### P1-P2 Notes

| Finding | Status | Detail |
|---------|--------|--------|
| `syncContextWindowForSelectedModel` testability | P2 | Tests require full extension lifecycle setup (closure dep on `modelRegistry`, `currentConfig`). Approach defers — acceptable for now. |
| `model_select` handler uses `ctx.model` (not `event.model`) | ✅ Correct | `ExtensionContext.model` IS the model object. The `_event` parameter is not used for model data. |

---

## What's Good

1. **P0.1 fix is correct and thorough.** Approach was revised to use `model` parameter directly at ALL call sites — no silent no-op risk.
2. **Decision table (§4) is sound.** CTW source selection for each case (next candidate on fallback, current ref when last, no sync on abort) follows clean engineering judgment.
3. **Edge cases are well-documented (§6).** Every edge case has an explicit behavior and acceptability callout. The "cooldowned next candidate" transient is correctly accepted.
4. **Backup plan exists** (Opsi A: re-register + setModel) but is deferred — correct YAGNI.
5. **Minimal footprint.** 2 files, ~25 lines net new code. No dependencies, no config changes.
6. **Ponytail-compatible.** No unnecessary abstractions, no scaffolding, direct mutation on a plain property.

**Ready for detail planning.**
