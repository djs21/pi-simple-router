# Handoff: Model Error State Invisibility

## Session

Bug fix session for pi-model-router: models that errored or hit rate limits were retried every turn instead of being skipped.

## What Was Done

See `docs/prd-error-state-invisibility.md` for full problem statement, solution, and user stories.

| Commit | What |
|---|---|
| `0d7ea60` | **Slice 1**: Removed `isTransientError` guard — ALL model errors (except abort) trigger `markRateLimited` in `routeStream` catch block |
| `e3edd12` | **Slice 2**: Added `markRateLimited` inside `tryModel` for error-after-content (mid-stream failures) |
| `85666ac` | Show fallback chain in footer via `model_select` event + `ctx.ui.setStatus()` |
| `4a12a0f` | Footer shows only the first non-cooldowned model (not entire chain) |

## Test Coverage

57 tests — `config.test.ts` (40), `provider.test.ts` (17). Run `npm test`.

New tests cover: non-transient error cooldown, cross-turn skip, error-after-content cooldown, RouterAbortError no-cooldown, provider-level cooldown, all verified via `getActiveRateLimits()` assertions.

## Beads Issues

```
pi-model-router-olj  ✅ Cooldown semua model error
pi-model-router-by6  ✅ Cooldown error-after-content
pi-model-router-q4s  ⏳ Integrasi practice/sign-off (HITL)
```

## Pending: Slice 3

Manual testing by human:
1. Reload extension in pi
2. Test with models that error — skip on next turn
3. `/router clearcache` resets cooldown
4. No regression — healthy models still used

## Suggested Skills

- **triage** — new bugs/feature requests via beads
- **to-issues** — break new plans into beads vertical slices
- **diagnose** — regression in fallback behavior
- **tdd** — maintain test pattern for fallback logic changes
- **write-a-skill** — if moving test patterns into a reusable skill

## Environment

- Repo: `github-pribadi:djs21/pi-simple-router.git`
- Branch: `master`
- CLI: `bd` issue tracker
- Tests: `npm test` (vitest), `npm run typecheck` (tsc --noEmit)
