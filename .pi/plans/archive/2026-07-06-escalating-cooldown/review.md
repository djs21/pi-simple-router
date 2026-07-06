# Code Review: Escalating Cooldown + SQLite Shared Backend

**Reviewed:** PRD `docs/prd-cooldown-escalation.md` + current implementation (`rate-limit-tracker.ts`, `provider.ts`, `constants.ts`, `commands.ts`, `provider.test.ts`) + issue breakdown (8gx, xsf, 2pk)

**Current state:** PRD/planning phase — no code changes yet. This review evaluates the design before implementation.
**Verdict:** NEEDS CHANGES

---

## Summary

The design is well-thought-out overall. SQLite is the right tool for cross-session persistence — a JSON file with flock would be as complex and less robust. The escalation tiers and error classification solve real problems. Three critical issues: (1) escalation is unreachable under common usage patterns, (2) testability of the SQLite module needs design work, and (3) concurrent-write handling is underspecified. Several moderate issues around edge cases and API design.

---

## Critical

### [P0] Escalation never triggers with spaced-out errors

**File:** `docs/prd-cooldown-escalation.md` (design, not yet code)

**Issue:** The escalation logic says: "consecutive counter is incremented when `markRateLimited` is called for the same model_ref with the same error_type **while the previous cooldown is still active**." When cooldown expires, the counter resets to 1, even if the model *never succeeded in between*.

Consequence: to reach tier 2 (1h), a model must error 5 times in <5 minutes. To reach tier 3 (6h), it needs 7 errors in <~1h. For a user who sends messages every 10 minutes, consecutive is always 1 — **the escalation system is completely invisible** to them.

This directly contradicts User Story #2: "I want the cooldown on that model's auth errors to escalate to 6 hours." A misconfigured API key produces one auth error per user message. If messages are 10+ minutes apart, escalation never fires.

**Suggested Fix:** Decouple the consecutive counter from cooldown expiry. Store consecutive count in a separate table or as a column that persists even after expiry. Only reset on explicit `resetCooldown(ref)` (i.e., when the model actually succeeds). This means a model with a dead API key accumulates consecutive errors over hours/days, eventually reaching 6h cooldown.

Trade-off: a model that's *never* used successfully would have an ever-growing consecutive counter. Over days this could reach absurd numbers. Solution: cap at some max (e.g., 20/24h tier) or decay over very long periods (e.g., halve the counter every 24h).

```
ponytail: simpler fix — store consecutive in the row, don't reset it on expiry. 
Add cap at, say, 12 (1 day tier). Reset only on explicit success (resetCooldown).
```

### [P0] SQLite module testability is underspecified

**File:** `docs/prd-cooldown-escalation.md` (approach), future `extensions/rate-limit-tracker.ts`

**Issue:** The PRD says tests use `:memory:` databases. But the current module exports stateless functions. Replacing with a module-level SQLite singleton (per the PRD) makes the module stateful with a hidden dependency. Tests that need `:memory:` would either:
0. Need a test-only setter to swap the DB connection — ugly but works.
1. Need every function to accept a DB handle — breaks the public API.
2. Need environment-based switching — fragile and non-obvious.

The PRD doesn't specify the mechanism for injecting the `:memory:` database in tests.

**Suggested Fix:** Make the DB connection explicit. Smallest change: add a module-level `setDbForTesting(db?: DatabaseSync)` function that tests call in `beforeEach`. Document it as test-only. The production path lazily creates the file-backed connection; tests override it.

```ts
// rate-limit-tracker.ts
let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (_db) return _db
  _db = new DatabaseSync(getDbPath())
  _db.exec('CREATE TABLE IF NOT EXISTS cooldowns (...)')
  _db.exec('PRAGMA busy_timeout = 5000')
  return _db
}

/** @internal — test only */
export function _setDbForTesting(db: DatabaseSync): void {
  _db = db
}
```

This is a `ponytail:`-level simplification: the setter is ugly but avoids factories/DI/DI frameworks. Keep it marked as internal.

### [P0] Concurrent writes from multiple pi sessions will throw

**File:** `docs/prd-cooldown-escalation.md` ("Multi-process file locking" section)

**Issue:** The PRD acknowledges this but dismisses it: "pi sessions are sequential on a single machine, so this is acceptable." This is wrong. Two terminal windows both running pi is a common workflow (chat in one, coding in another). When both hit the same model (e.g., both rate-limited), both sessions write cooldown state at roughly the same time → `SQLITE_BUSY`.

The synchronous `DatabaseSync` API doesn't have a built-in retry. Without `PRAGMA busy_timeout`, concurrent writes **will** throw.

**Evidence:** Verified that `PRAGMA busy_timeout = 5000` is supported in `node:sqlite` on the host Node.js version (v24). The PRD mentions WAL mode is "future" but WAL only helps readers — writers still serialize.

**Suggested Fix:**
0. Add `PRAGMA busy_timeout = 5000` to the connection setup (not "future work"). This makes writes retry for up to 5s before throwing.
1. Wrap the three write operations (`markRateLimited`, `clearRateLimits`, `resetCooldown`) in a try-catch that logs and falls through gracefully. If a concurrent write fails after timeout, the worst that happens is the cooldown wasn't recorded — the model gets retried on the next turn, which is acceptable degradation.
2. Add WAL mode: `PRAGMA journal_mode=WAL` — it's one line and measurably better for concurrent reads.

`PRAGMA` calls are cheap and idempotent. No reason to defer them.

---

## Important

### [P1] `resetCooldown` success signal is tricky to wire in error-after-content

**File:** `docs/prd-cooldown-escalation.md` ("What Happens After Cooldown Expires"), `extensions/provider.ts:tryModel`

**Issue:** The PRD says "After a successful model response (stream completes without error), call `resetCooldown(ref)`." In `tryModel`, success is detected at `event.type === 'done'`. The function returns `true` and `routeStream` exits. This is the right place.

But: error-after-content currently calls `markRateLimited` inside the iterator loop but the stream still continues to `done` (line 297-299 in current provider.ts). So the sequence for error-after-content is: `text_delta` → `error` → `done`. The `markRateLimited` fires on the `error` event. Then `done` fires and `tryModel` returns `true` (success!). So `resetCooldown` would cancel the cooldown we just set.

**Suggested Fix:** When an error-after-content occurs, `tryModel` should NOT return `true` when the subsequent `done` event fires. The error-after-content handling currently calls `markRateLimited` but does NOT prevent the outer loop from treating it as a success.

The cleanest fix: after handling `event.type === 'error'` with `contentReceived === true`, set a flag `erredAfterContent = true`. Then when `event.type === 'done'`, check this flag: if set, call `stream.end()` and return `false` (failure) instead of `true`. This way the outer `routeStream` catch block handles it uniformly and applies cooldown consistently.

### [P1] `isTransientError` → `classifyError` rename breaks existing code

**File:** `extensions/rate-limit-tracker.ts` (planned change)

**Issue:** The PRD says `isTransientError()` → `classifyError()`, keeping the old name as deprecated alias. The PRD for error-state-invisibility (Slice 1/2 of the *previous* feature) says "Remove the `isTransientError` guard from the catch block" — meaning it's no longer used as a gate for cooldown.

If `isTransientError` is no longer used in `provider.ts` (no `if (isTransientError(err)) ...` guard), then keeping it as a backward-compat wrapper adds dead code. The only possible consumer is external code importing from the extension — which is unlikely for a single-user pi extension.

**Suggested Fix:** Delete `isTransientError` entirely. Rename to `classifyError`. No dead wrappers. If someone complains, add it back. YAGNI applies to backward-compat stubs too.

### [P1] Provider-level cooldown still uses `rateLimitCooldownMs` — not escalated, but also not separate

**File:** `docs/prd-cooldown-escalation.md` ("Provider-level cooldown ... does not escalate.")

**Issue:** Provider-level cooldowns use `config.rateLimitCooldownMs` (default 5m). But provider outages (502/503) are arguably more serious than individual model errors. If the entire OpenAI API is down for 2 hours, a 5-minute cooldown means every turn retries every OpenAI model, gets 502, cooldowns for 5 minutes, then retries again.

**Suggested Fix:** Not necessarily a code change, but the PRD should document this limitation. A future improvement could be a separate, longer cooldown for provider-level failures (e.g., 30 minutes default). For now, just acknowledge it.

### [P1] `/router status` uses `getActiveRateLimits()` which becomes SQLite-backed — need to handle the async timing

**File:** `extensions/commands.ts`

**Issue:** Currently `getActiveRateLimits()` is synchronous and O(n). With SQLite, it's still synchronous (good) but now reads from disk. Every `/router status` call does a SQL query. This is fine for performance (tiny table), but the return type shape changes — adding `errorType` and `consecutive` fields. The command needs to display these new fields.

**Suggested Fix:** Straightforward — just update the display logic. But make sure the change is backward-compatible if any external code calls `getActiveRateLimits()`.

### [P1] `clearRateLimits` concurrency — race with concurrent writes

**File:** `extensions/rate-limit-tracker.ts` (planned)

**Issue:** Session A calls `clearRateLimits()` (DELETE FROM cooldowns). Session B simultaneously calls `markRateLimited` (INSERT/UPDATE). With `busy_timeout`, one will wait for the other. But the sequence matters: if `markRateLimited` wins, then `clearRateLimits` deletes the entry. User expects "all cleared."

With `busy_timeout`, this works correctly — once `clearRateLimits` acquires the write lock, it runs atomically. The small race window is the time between `clearRateLimits` checking "is there a cooldown?" and writing the "clear" state. This is acceptable.

### [P1] Error type classification regex is fragile

**File:** `extensions/rate-limit-tracker.ts` (planned `classifyError()`)

**Issue:** The current `TRANSIENT_PATTERNS` uses simple `msg.includes(pattern)`. The proposed `classifyError()` would categorize these into groups. Substring matching can misfire:

- `"timeout"` matches `"The model 'timeout-model' is not available"` (false positive → misclassification as "timeout")
- `"auth"` could match `"The author's name is too long"` (unlikely but possible)
- `"backend"` matches `"The backend API is down"` (correct) but also `"The backender's wallet is empty"` (nonsensical but theoretically possible)

The fallback `"other"` category saves this from being a correctness issue. A misclassification means the counter resets to 1 instead of incrementing → slightly under-cooldowns the model. Not critical.

**Suggested Fix:** Better ordering and more specific patterns: check `"429"` and `"401"` / `"403"` etc. before generic patterns. Use `CTRL+F`-style specific substrings before generic ones. But honestly, for this codebase's scope, the current approach is fine — just document that `"other"` is the safe fallback.

---

## Nitpick

### [P2] `consecutive` column in schema: uint should not be signed

**File:** `docs/prd-cooldown-escalation.md` (schema)

**Issue:** Schema shows `consecutive INTEGER DEFAULT 1`. SQLite doesn't have UNSIGNED INTEGER. The column could theoretically hold negative values if some bug decrements it. Add a `CHECK(consecutive >= 1)` constraint to catch bugs early.

### [P2] `updated_at` column is never used in the described logic

**File:** `docs/prd-cooldown-escalation.md` (schema)

**Issue:** The schema includes `updated_at INTEGER NOT NULL` but the escalation logic doesn't reference it. Dead column. Delete it unless there's a planned use (e.g., "last error was 24h ago, reset counter"). YAGNI.

### [P2] `DEFAULT_RATE_LIMIT_COOLDOWN_MS` becomes redundant with tier constants

**File:** `extensions/constants.ts`

**Issue:** After adding `ESCALATION_COOLDOWN_TIER_1_MS = 300_000`, the existing `DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000` has the same value. Should `DEFAULT_RATE_LIMIT_COOLDOWN_MS` become an alias for `ESCALATION_COOLDOWN_TIER_1_MS`? Or should it remain separate for cases like provider-level cooldown that don't follow tier logic?

Suggestion: keep `DEFAULT_RATE_LIMIT_COOLDOWN_MS` as the current constant (5m). Use it as the value for tier 1. Providers that don't escalate use this constant. Avoids breaking any config reference.

### [P2] Float in `timer.ts` style: `model_ref` vs. `modelRef` in SQL

**File:** `docs/prd-cooldown-escalation.md` (schema)

**Issue:** SQL schema uses `snake_case` columns (`model_ref`, `error_type`, `expiry_at`). TypeScript code uses `camelCase`. Not a problem per se, but the TypeScript adapter layer needs to translate between the two. With `node:sqlite`'s direct row access, rows come back with snake_case keys. The public API returns camelCase objects. This translation needs to happen somewhere.

Either: use `AS modelRef` in SQL queries, or map in the result transformation. Document the approach.

### [P2] ``:memory:`` database isolation — one per test, not one per module

**Issue:** If `rate-limit-tracker.test.ts` creates a module-level `:memory:` database and all tests share it, tests within the file will interfere with each other (parallel execution in vitest). Solution: each test (or `describe`) creates its own `:memory:` database via `_setDbForTesting()` in `beforeEach`.

### [P2] Per-model `rateLimitCooldownMs` config field becomes ambiguous

**File:** `extensions/types.ts`

**Issue:** `RouterConfig.rateLimitCooldownMs` currently means "the cooldown duration." After this change, it's unclear whether this config field sets the base tier duration or overrides the entire escalation curve. The PRD says per-model config is out of scope, but even the top-level config's relationship to the new tier system needs documentation.

Suggestion: document that `rateLimitCooldownMs` sets the **base tier** (tier 1) duration. Escalation tiers are always relative to this base.

---

## Praise

- **SQLite over JSON file is the right call.** Cross-session persistence needs atomic reads and writes. A JSON file with flock is equally complex. SQLite gives you transactions, `:memory:` for testing, and zero new dependencies.

- **Synchronous API choice matches the codebase.** The rest of the extension is synchronous cooldown checks called from `routeStream`. Adding async would cascade changes. `node:sqlite`'s synchronous API is exactly right for this single-user, low-concurrency use case.

- **Lazy initialization.** "No startup penalty if no cooldowns are active" is a good pattern. The current code already has this implicitly (the Map is always empty on init). SQLite lazy init maintains this property.

- **Error category isolation.** Resetting the consecutive counter on different error types is smart. A model that gets rate-limited (provider throttling) and then auth errors (misconfigured key) shouldn't compound these into one escalating sequence — they're different problems.

- **`PRAGMA busy_timeout` is available** in `node:sqlite` on Node v24 (confirmed by empirical check). This makes concurrent-write handling straightforward.

- **Provider-level cooldown uses distinct error type.** Using `"provider_outage"` as the error type and explicitly skipping escalation for it is clean separation. The `__provider:` prefix convention is already established.

- **`resetCooldown` on success is safe to call unconditionally.** Since it deletes the row (if exists) or is a no-op (if not), there's no harm in calling it on every successful response. This simplifies the wiring significantly.

- **Test count stays consistent.** 57 existing tests pass (confirmed). The `:memory:` SQLite approach means no setup/teardown of file databases for tests.

- **The PRD explicitly calls out what's out of scope.** Per-model config, persistent classification, DB migration, TUI changes, and multi-process locking are all correctly marked as not part of this change. This keeps scope manageable.

---

## Summary of Required Changes

| # | Priority | Issue | Suggested Fix |
|---|---|---|---|
| 1 | P0 | Escalation never triggers for spaced-out errors | Decouple consecutive counter from cooldown expiry |
| 2 | P0 | Testability of SQLite module | Add `_setDbForTesting()` or DI mechanism |
| 3 | P0 | Concurrent writes throw `SQLITE_BUSY` | Add `PRAGMA busy_timeout=5000` on init |
| 4 | P1 | Error-after-content + resetCooldown race | Flag `erredAfterContent` in tryModel |
| 5 | P1 | `isTransientError` dead code after rename | Delete it, no backward-compat stub |
| 6 | P1 | Provider-level cooldown too short | Document limitation, increase default? |
| 7 | P1 | `getActiveRateLimits` return type changes | Update all callers |
| 8 | P2 | `consecutive` no CHECK constraint | Add `CHECK(consecutive >= 1)` |
| 9 | P2 | `updated_at` is dead column | Remove from schema |
| 10 | P2 | `DEFAULT_RATE_LIMIT_COOLDOWN_MS` redundancy | Keep as tier 1 base, document intent |
| 11 | P2 | snake_case/camelCase translation in SQL | Add explicit `AS` aliases |
