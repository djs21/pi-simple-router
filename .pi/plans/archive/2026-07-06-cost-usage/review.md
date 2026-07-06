# Code Review: Cost & Usage Tracking Plan

**Reviewed:** Plan `.pi/plans/2026-07-06-cost-usage/plan.md` against current codebase
**Verdict:** **APPROVED** — all findings have been addressed. Gas workers.

## Re-Review Summary

All 4 findings from the initial review have been verified as fixed in the revised plan:

| # | Finding | Status Fix |
|---|---------|------------|
| 1 | try-finally causes duplicate `recordUsage` rows | ✅ **Fixed.** Plan explicitly says "No try-finally." Three explicit capture points (success, error-after-content, error-before-content), no overlapping coverage. |
| 2 | Footer mechanism — `output.usage` not read by pi | ✅ **Fixed.** Plan removes all `output.usage` assignments. Task 2.2 explains delegated stream events carry real usage through `response.result()`. Verified via SDK analysis in Appendix A. |
| 3 | Cleanup-all race with timestamp precision | ✅ **Fixed.** Plan uses `Number.MAX_SAFE_INTEGER` for `all` interval instead of `Date.now() + 86400000`. No race condition. |
| 4 | Token formatting — missing locale separators | ✅ **Fixed.** Plan uses `String(row.inputTokens).toLocaleString().padStart(8)` for all token columns. |

## What's Still Good

- DB reuse via `getDb()` singleton — correct, minimal
- Test strategy with `:memory:` SQLite — hermetic, following established patterns
- Error-handling discipline — all capture wrapped in try-catch, fire-and-forget
- Table creation in `getDb()` — centralized init, no coordination between lazy inits
- `output.model` as router name — no new parameter needed in `tryModel`
- Command format — simple string padding, no external table library

## Ready to Implement

The plan is structurally sound and all blocking issues are resolved. Workers can proceed with Batch 1 → 2 → 3 → 4 in order.
