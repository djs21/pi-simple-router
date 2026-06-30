# PRD: Model Error State Invisibility — Skip Failed Models on Subsequent Turns

## Problem Statement

The router extension iterates through a fallback chain of models on every turn (`streamSimple` call). When a model errors or hits a rate limit, the error state is not always recorded in the cooldown map (`RATE_LIMITED`). This causes two problems:

1. **Permanent retry loop**: Models that fail with non-transient errors (e.g. model not found, generic upstream error) are never marked for cooldown. They retry on every turn, burn time, and fail again — wasting 10-30 seconds per turn before reaching a working model.

2. **Error-after-content misses cooldown**: If a model streams partial content then errors (e.g. rate-limited mid-response), the error event is forwarded to the user but `markRateLimited` is never called. On the next turn the same model is tried again from scratch.

**Current behaviour** (7 models, models 1-3 broken, model 4 working):

```
Turn 1:  model 1 (rate-limit, 3s) → model 2 (error, 3s) → model 3 (error, 3s) → model 4 ✓
Turn 2:  model 1 (rate-limit, 3s) → model 2 (error, 3s) → model 3 (error, 3s) → model 4 ✓
Turn 3:  model 1 (rate-limit, 3s) → model 2 (error, 3s) → model 3 (error, 3s) → model 4 ✓
...
```

Every turn wastes ~9s retrying models that are guaranteed to fail.

## Solution

Make ALL failed models "invisible" on subsequent turns by applying cooldown to every error — not just "transient" errors matching a fixed keyword list. When a model fails for any reason (rate limit, transient server error, permanent error, error-after-content), it enters cooldown and is skipped on the next turn.

**Expected behaviour:**

```
Turn 1:  model 1 (rate-limit)                 → model 2 (error) → model 3 (error) → model 4 ✓
Turn 2:  model 4 ✓                              (1,2,3 invisible)
Turn 3:  model 4 ✓                              (1,2,3 invisible)
Turn 4:  model 4 (rate-limit)                  → model 5 ✓
Turn 5:  model 5 ✓                              (1,2,3,4 invisible)
```

- All failed models get cooldown → invisible on next turn
- Rate-limited models get cooldown (unchanged)
- Error models get cooldown (NEW — previously only transient errors)
- Error-after-content models get cooldown (NEW — previously never cooldowned)
- Cooldown expiry re-enables the model (if still broken, fails again and re-enters cooldown)
- `/router clearcache` resets all cooldowns manually

## User Stories

1. As a pi user with a router worker of 7 models where models 1-3 are consistently failing, I want those failed models to be skipped entirely on subsequent turns, so that I don't waste 9+ seconds per turn waiting for guaranteed failures.

2. As a pi user experiencing rate limits, I want rate-limited models to enter cooldown and be skipped on subsequent turns, so that I never retry a rate-limited model before its cooldown expires.

3. As a pi user whose model errors with a non-standard error message (e.g. "The provider encountered an issue"), I want that model to still be marked for cooldown and skipped on future turns, so that even errors with non-matching message patterns don't cause infinite retry loops.

4. As a pi user whose model streams partial content then hits a rate limit mid-response, I want that model to still be marked for cooldown on future turns, so that error-after-content scenarios don't silently bypass the cooldown system.

5. As a pi user whose temporarily-broken model recovers after some time, I want cooldowns to naturally expire and re-enable the model, so that recovered models are automatically tried again without manual intervention.

6. As a pi user who wants to force-reset all cooldowns (e.g. after adding a new API key), I want `/router clearcache` to clear all error states, so that I can manually reset the cooldown system.

7. As a pi user, I want the fallback notification message to clearly distinguish between "rate-limited (cooldown)" and "error (cooldown)" and "error (permanent)", so that I understand why specific models are being skipped.

8. As a pi user whose provider-wide outage occurs (502/503), I want the entire provider's models to be cooldowned, so that I don't retry each model of a dead provider individually.

9. As a developer maintaining the router extension, I want the cooldown logic to be testable via unit tests that verify `markRateLimited` is called for ALL error types, so that the fix is regression-proof.

10. As a developer maintaining the router extension, I want the `isRateLimited` check to correctly skip cooldowned models across multiple `streamSimple` calls, so that the "skip on next turn" behaviour works reliably.

## Implementation Decisions

### Module Changes

- **`extensions/provider.ts`** — Core changes to error handling in `routeStream` and `tryModel`:
  - Remove the `isTransientError` guard from the catch block. ALL errors (abort/timeout excluded) trigger `markRateLimited`.
  - After the `tryModel` loop completes, if an error was recorded (even after content was sent), call `markRateLimited`.
  - Provider-level cooldown (`__provider:{name}`) remains gated on `isProviderLevelError` — this is correct because only provider-wide outages (502, 503, 504) should cooldown the entire provider.

- **`extensions/rate-limit-tracker.ts`** — No structural changes needed. The `markRateLimited`/`isRateLimited` API is sufficient as-is. The fix is in how `provider.ts` calls them.

- **`extensions/provider.test.ts`** — New test suites:
  - `markRateLimited` is called for ALL error types (not just transient)
  - `markRateLimited` is called for errors after content
  - `isRateLimited` causes `streamSimple` to skip cooldowned models on the next call
  - Provider-level cooldown still only triggered by provider-level errors

### Error-after-content Handling

The `tryModel` function's async iterator loop forwards errors as stream events even after content is received. To ensure cooldown is applied:

- Track whether ANY error was emitted by the delegated stream, regardless of `contentReceived`.
- After the stream loop ends (or errors), if an error was recorded, let the outer catch in `routeStream` handle it as a failure.
- This means `tryModel` should throw (or propagate) for error-after-content too, so the catch block can apply cooldown uniformly.

### What Happens After Cooldown Expires

When a model's cooldown expires (default 5 minutes), `isRateLimited` returns `false`, and the model is eligible for retry. If it fails again, it re-enters cooldown. This is the desired behaviour — models that recover naturally are re-tried.

### Terminology in User-Facing Messages

The PRD doesn't mandate exact strings, but fallback notification messages should distinguish:

- **Cooldown skip** (from previous failure): `"⏳ model X cooldown (remaining Y)"` — unchanged
- **Fresh failure, falling back**: `"⚠️ model X failed, falling back to model Y"` — unchanged
- The distinction is already correct in current code; the fix is about making sure cooldown entries are actually created for all failure types.

## Testing Decisions

### What Makes a Good Test

- Tests verify **external behaviour** — what `streamSimple` returns, not which internal functions were called
- Tests exercise the REAL `routeStream` path through the registered `streamSimple` function
- "Call `streamSimple` with mocked delegated `streamSimple`" is the right seam
- Test assertions are on stream events and on `getActiveRateLimits()` output

### Test Seams (highest first)

1. **`streamSimple` (functional, per-turn)** — the same function pi calls. Test:
   - Single call with a model that errors before content → `markRateLimited` called
   - Single call with a model that errors after content → `markRateLimited` called
   - Single call with a transient error → `markRateLimited` called (regression)
   - Single call with a non-transient error → `markRateLimited` called (NEW — the core fix)
   - Two sequential calls: first fails, second skips the failed model → directly tries the next
   - Provider-level error (502) → `__provider:{name}` cooldown created
   - Provider-level check → all models from that provider skipped

2. **`rate-limit-tracker.ts` (unit)** — the public API. Test:
   - `markRateLimited` + `isRateLimited` roundtrip
   - Expired cooldown is lazily cleaned up
   - `getActiveRateLimits` returns only non-expired entries
   - `clearRateLimits` resets all state

### Prior Art

- `extensions/provider.test.ts` already mocks `streamSimple` from `@earendil-works/pi-ai/compat` and tests `registerRouterProvider`
- Same mocking pattern extends naturally: mock `streamSimple` to throw/send error events, invoke the router's `streamSimple`, assert the stream events and cooldown state

## Out of Scope

- **Persistent cooldown across pi restarts**: Cooldown is in-memory only (Map). This PRD does not add persistence. On restart, all models are fresh.
- **Per-model cooldown duration config**: Uses a single `rateLimitCooldownMs` for all models. Per-model cooldown config is future work.
- **Separate "permanent error" blacklist**: Non-transient errors currently get the same cooldown as transient errors. A separate permanent blacklist (models that should never be retried) is out of scope.
- **Heuristic routing**: No changes to the model selection algorithm beyond cooldown-based skipping.
- **TUI changes**: No changes to UI components.

## Further Notes

- The `isTransientError` function in `rate-limit-tracker.ts` continues to exist and may be useful for telemetry/logging even though it no longer gates cooldown application.
- Provider-level cooldown (`__provider:{name}`) correctly checks `isProviderLevelError` — only 502/503/504-like errors should cooldown the entire provider. Individual model errors should only cooldown that specific model.
- The existing "abort" guard (`RouterAbortError`) correctly does NOT trigger cooldown — pi-level timeouts are not model failures.
- After implementing, run `npm run typecheck` and `npm test` to verify no regressions.
