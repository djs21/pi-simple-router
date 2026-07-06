# PRD: Escalating Cooldown with Shared SQLite Backend

## Problem Statement

The router extension's cooldown system has two limitations that reduce its effectiveness in real-world usage:

1. **Session isolation**: Cooldown state lives in an in-memory `Map`. When a user runs pi in multiple terminals (e.g. one for chat, one for coding), each session maintains its own cooldown state. A rate-limited model in terminal 1 is immediately re-tried in terminal 2, hitting the same rate limit. State should be shared across all pi sessions.

2. **Flat cooldown duration**: Every error gets the same 5-minute cooldown (`DEFAULT_RATE_LIMIT_COOLDOWN_MS`). A model that errors 10 times consecutively with the same error type gets no more cooldown than one that errors once. Under persistent outages (provider degradation, misconfigured API key), the router wastes 9+ seconds per turn retrying the same failing model every 5 minutes — over and over until the user manually runs `/router clearcache`.

## Solution

**Replace the in-memory `Map` with a local SQLite database** (via built-in `node:sqlite`, Node 22+) so cooldown state persists across pi sessions and is shared between terminals.

**Add escalating cooldown tiers** based on consecutive same-type errors, so persistently failing models stay out of the fallback chain for progressively longer periods.

## User Stories

1. As a pi user with two terminals open, I want cooldown state to be shared between them, so that a rate-limited model in one session is immediately skipped in the other.

2. As a pi user whose API key is misconfigured for a specific provider, I want the cooldown on that model's auth errors to escalate to 6 hours, so that the router does not waste time retrying it every 5 minutes.

3. As a pi user whose provider is having an intermittent outage, I want temporary failures (1-4 consecutive) to get only 5 minute cooldown, so that the model is re-tried reasonably soon after recovery.

4. As a pi user who uses `/router clearcache`, I want all cooldowns (including escalated ones) to be cleared immediately, so that I can force-reset the system after fixing an issue.

5. As a pi user who restarts pi, I want cooldown state to survive the restart (unlike the current in-memory Map), so that I don't immediately retry failure-prone models after a restart.

6. As a pi user whose model fails with a transient error then later succeeds, I want the consecutive error counter to reset on success, so that the cooldown returns to the base 5-minute tier.

7. As a pi user whose model fails with different error types (e.g. first `rate_limit` then `auth`), I want the consecutive counter to reset between different error types, so that each error type is tracked independently.

8. As a developer maintaining the router extension, I want the SQLite backend to be testable via `:memory:` databases, so that tests don't pollute the real database file.

9. As a developer maintaining the router extension, I want the cooldown escalation logic to have deterministic unit tests that verify tier transitions (5m → 1h → 6h), so that escalation edge cases are regression-proof.

10. As a pi user, I want `/router status` to show escalating cooldown details (error type, consecutive count, tier), so that I understand why a model has a long cooldown.

## Implementation Decisions

### SQLite Backend (replaces in-memory Map)

- Use built-in `node:sqlite` (Node.js 22+ built-in module via `node:sqlite`). No additional dependencies.
- Database location: `~/.local/share/pi/model-router.db` — respecting `$XDG_DATA_HOME` when set, falling back to `~/.local/share/pi/`.
- Schema:

```sql
CREATE TABLE IF NOT EXISTS cooldowns (
  model_ref     TEXT PRIMARY KEY,
  error_type    TEXT NOT NULL,
  expiry_at     INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  consecutive   INTEGER DEFAULT 1 CHECK(consecutive >= 1)
);
```

- The module lazily initializes the database connection on first operation. No startup penalty if no cooldowns are active.
- All public API functions (`markRateLimited`, `isRateLimited`, `getActiveRateLimits`, `clearRateLimits`, `getRemainingCooldownMs`) remain synchronous — using the synchronous `node:sqlite` API which is appropriate for this single-user local database with low concurrency.
- The database connection is a module-level singleton, created once when first needed with:
  - `PRAGMA journal_mode = WAL` — concurrent readers don't block each other
  - `PRAGMA busy_timeout = 5000` — write waits up to 5s before throwing `SQLITE_BUSY`
- Tests use a `:memory:` database injected via `_setDbForTesting(db?)` — an internal export that overrides the module-level connection for hermetic testing.

### Error Type Classification

- `isTransientError()` changes from a boolean return to a category string:
  - `"rate_limit"` — rate limit / quota errors (existing `RATE_LIMIT_PATTERNS`)
  - `"server_error"` — 5xx, upstream failures (server-side transient)
  - `"timeout"` — connection timeouts, ECONNRESET, etc.
  - `"auth"` — authentication failures, invalid API key, 401/403 responses
  - `"other"` — everything else (model not found, invalid ref, etc.)
- The function is renamed to `classifyError()` to reflect the new return type. The old `isTransientError` is removed entirely — there are no remaining callers and backward-compat stubs are dead code.
- Callers in `provider.ts` use the category string when calling the updated `markRateLimited`.

### Escalating Cooldown Tiers

| Consecutive Same-Type Errors | Cooldown Duration | Notes |
|---|---|---|
| 1–4 | 5 minutes (300,000 ms) | Base tier, same as current default |
| 5–6 | 1 hour (3,600,000 ms) | Escalates at 5th consecutive same-type error |
| 7+ | 6 hours (21,600,000 ms) | Cap — never exceeds 6h |

- `consecutive` counter is stored in the `cooldowns` table. It is **decoupled from cooldown expiry** — the counter persists even after the cooldown expires. This ensures escalation works even for spaced-out errors (e.g., user messages every 10 minutes).
- Counter is incremented when `markRateLimited` is called for the same `model_ref` with the same `error_type`.
- Counter resets to 1 when:
  - A different error type is recorded for the same model (switching categories), OR
  - `resetCooldown(ref)` is called explicitly (i.e., the model responded successfully)
- Counter has a **cap at 12** to prevent unbounded growth (`consecutive <= 12`). At 12+ same-type errors, cooldown stays at max tier (6h). This prevents absurd durations from accumulated errors over days.
- A new public function `resetCooldown(ref: string)` resets the consecutive counter without adding a fresh cooldown. Callers who succeed after expiry call this to clear escalation state.
- The duration is computed from the current consecutive count (after incrementing) — not stored as a fixed value per tier, allowing the formula to change.

### Module Changes

- **`extensions/rate-limit-tracker.ts`** — Major rewrite:
  - Replace module-level `const RATE_LIMITED = new Map<string, number>()` with SQLite-backed storage
  - `isTransientError()` → `classifyError()` returning category string. Keep `isTransientError` as a thin wrapper returning boolean for the transitional period.
  - `markRateLimited(ref, cooldownMs?)` → `markRateLimited(ref, cooldownMs?, errorType?)`. When `errorType` is provided and matches the existing entry's type while still in cooldown, increment the consecutive counter and apply the escalating duration. When `errorType` differs or no active cooldown, reset to 1.
  - Add `resetCooldown(ref)` function — clears the cooldown entry entirely so next call starts fresh.
  - `clearRateLimits()` — deletes all rows from the table (not just in-memory clear).
  - All public functions remain synchronous.

- **`extensions/provider.ts`** — Updated call sites:
  - Replace `isTransientError()` usage with `classifyError()` where error type is needed for storage.
  - Pass error type to `markRateLimited(ref, config.rateLimitCooldownMs, errorType)`.
  - After a successful model response (stream completes without error), call `resetCooldown(ref)` so the consecutive counter resets.
  - Provider-level cooldown (`__provider:{name}`) uses `"provider_outage"` as its error type — this ensures provider-level cooldowns don't interfere with model-level escalation counters. Provider-level cooldowns do NOT escalate and remain at the base 5-minute duration via `config.rateLimitCooldownMs`. This is a documented limitation: during a 2-hour provider outage, every turn still retries the provider every 5 minutes. Future improvement: separate longer default for provider-level failures.

- **`extensions/constants.ts`** — Add tier constants:
  - `ESCALATION_TIER_1_MAX = 4` — max consecutive before escalating to 1h
  - `ESCALATION_TIER_2_MIN = 5` — 1h tier starts here
  - `ESCALATION_TIER_2_MAX = 6` — max consecutive before escalating to 6h
  - `ESCALATION_TIER_3_MIN = 7` — 6h tier starts here (cap)
  - `ESCALATION_COOLDOWN_TIER_1_MS = 300_000` — 5 minutes
  - `ESCALATION_COOLDOWN_TIER_2_MS = 3_600_000` — 1 hour
  - `ESCALATION_COOLDOWN_TIER_3_MS = 21_600_000` — 6 hours

- **`extensions/provider.test.ts`** — New test suites:
  - Cross-session cooldown persistence (create `:memory:` database, verify state)
  - Escalating cooldown: 5 same-type errors → 1h tier, 7 same-type errors → 6h tier
  - Counter reset on different error type
  - Counter reset after cooldown expiry + `resetCooldown`
  - `resetCooldown` clears escalation

- **`extensions/rate-limit-tracker.test.ts`** — New file, unit tests:
  - SQLite operations (`:memory:` database)
  - `classifyError()` returns correct category for various error messages
  - `markRateLimited` + `isRateLimited` roundtrip via SQLite
  - Escalation tier calculation function
  - Expired entry cleanup

### What Happens After Cooldown Expires

When a model's cooldown expires, `isRateLimited` returns `false` and the model is eligible for retry. **The consecutive counter is NOT reset on expiry** — this is the key design choice that makes escalation work for spaced-out errors. The old entry remains in the DB with its `consecutive` count. If the model fails again with the same error type, `markRateLimited` sees an existing entry with matching `error_type` and increments `consecutive`, applying the escalated duration immediately. If the model succeeds, `resetCooldown(ref)` deletes the entry — next failure starts at consecutive=1, 5-minute tier.

### `/router status` Display

The `/router status` command (in `commands.ts`) already calls `getActiveRateLimits()`. The output is extended to show error type and consecutive count for each cooldowned model:

```
⏳ Rate Limits:
   openai/gpt-4: 4m 32s remaining (auth, consecutive: 1 → 5m tier)
   anthropic/claude-3: 59m 18s remaining (rate_limit, consecutive: 5 → 1h tier)
```

This does not require a new subcommand — the existing `getActiveRateLimits` return type is extended with `errorType` and `consecutive` fields.

## Testing Decisions

### What Makes a Good Test

- Tests verify **external behaviour** — what `streamSimple` returns, what cooldown state looks like after various failure sequences
- SQLite tests use `:memory:` databases so they are hermetic and fast
- Escalation logic is tested deterministically without waiting for real time (fake timers or direct function calls)
- "Call `streamSimple` with mocked delegated `streamSimple`" remains the right seam for integration tests

### Test Seams (highest first)

1. **`streamSimple` (functional, per-turn)** — same as existing tests. Test:
   - Same-type error 5x across sequential calls → cooldown escalates to 1h
   - Same-type error 7x → cooldown escalates to 6h (cap)
   - Different error types → counter resets, stays at 5m tier
   - Success after cooldown → `resetCooldown` clears escalation
   - Error after content → cooldown with correct error type

2. **`rate-limit-tracker.ts` (unit)** — new dedicated test file:
   - `classifyError()` returns correct category for each error message pattern
   - `markRateLimited` + `isRateLimited` roundtrip via `:memory:` SQLite
   - Escalation: consecutive=1 → 5m, consecutive=5 → 1h, consecutive=7 → 6h
   - Counter reset on different error type
   - Counter reset on expired + new `markRateLimited` call
   - `resetCooldown` clears entry entirely
   - `clearRateLimits` deletes all rows
   - `getRemainingCooldownMs` returns correct value
   - Multiple models tracked independently

3. **Cross-session persistence (functional)** — two sequential `streamSimple` calls simulating different sessions:
   - First call creates a cooldown entry
   - Verify the entry is present (reading from SQLite)
   - Simulate a second session (re-import the module or re-read from same db file)
   - Verify the entry is still present

### Prior Art

- `extensions/provider.test.ts` mocks `streamSimple` from `@earendil-works/pi-ai/compat` and tests cooldown behaviour through the registered `streamSimple` function
- The `delegatedStream` helper pattern extends naturally to incremental failure counting across calls
- Rate-limit-tracker currently has no test file — this is the first one, using `:memory:` SQLite as the test fixture

## Out of Scope

- **Per-model cooldown duration config**: All models share the same tier durations. Per-model overrides are future work.
- **Persistent error type classification config**: The `TRANSIENT_PATTERNS` and category mapping are hardcoded. Configurable patterns are future work.
- **Database migration**: The first version creates the schema fresh (`CREATE TABLE IF NOT EXISTS`). Migration support for schema changes is future work.
- **TUI changes**: No changes to TUI components. The `/router status` text output is extended but no visual components are modified.
- **Multi-process file locking**: Handled via `PRAGMA busy_timeout=5000` + WAL mode. Two pi sessions writing simultaneously will retry up to 5s before throwing. If throw occurs, the cooldown is not recorded — model gets retried next turn, acceptable degradation.

## Further Notes

- Node.js 22+ is required for `node:sqlite`. The project already targets modern Node (see `tsconfig.json` bundler resolution) but this dependency should be documented.
- The `XDG_DATA_HOME` resolution follows the XDG Base Directory Specification — check `$XDG_DATA_HOME` first, fall back to `~/.local/share`.
- Database file should be created with `0o700` permissions (user-only access) since it may contain model identifiers that reveal provider usage patterns.
- The `:memory:` SQLite database for tests is isolated per test file — parallel test execution is safe because each test file gets its own in-memory database. If tests within a file are parallel, each test should create its own in-memory database via `beforeEach`.
- Provider-level cooldown (`__provider:{name}` entries) uses error type `"provider_outage"` and does not escalate. These entries always get the base `rateLimitCooldownMs` duration. Escalation logic only applies to model-level entries.
