# Plan: Escalating Cooldown + Shared SQLite Backend

**Date:** 2026-07-06
**Status:** Draft
**Directory:** `/home/djs/project/pi-model-router`
**Source PRD:** `docs/prd-cooldown-escalation.md`
**Design review:** `.pi/plans/2026-07-06-escalating-cooldown/review.md`
**Issues:** `pi-model-router-8gx` (Slice 1), `pi-model-router-xsf` (Slice 2), `pi-model-router-2pk` (Slice 3)

---

## Context / Problem Statement

The pi-model-router extension's cooldown system has two limitations:

1. **Session isolation**: Cooldown state lives in an in-memory `Map<string, number>`. Running pi in multiple terminals (chat + coding) means each session maintains its own cooldown state. A rate-limited model in terminal 1 gets immediately retried in terminal 2.

2. **Flat cooldown duration**: Every error gets 5 minutes. A model that errors 10 times consecutively gets no more cooldown than one that errors once. Under persistent outages, the router wastes ~9+ seconds per turn retrying the same failing model every 5 minutes until the user manually runs `/router clearcache`.

**Evidence from codebase:**
- `extensions/rate-limit-tracker.ts` uses `Map<string, number>` — no persistence. (`review.md` P0#1 confirmed)
- `markRateLimited(ref, cooldownMs)` sets a fixed duration. No error type awareness, no escalation. (`review.md` P0#1)
- `isTransientError()` returns boolean — callers in `provider.ts:tryModel()` and `routeStream()` use it for cooldown gating. (`review.md` P1#5)
- 57 existing tests pass, cooldown tests use `clearRateLimits()` in `beforeEach`. (`provider.test.ts:102`)
- `router status` shows `ref` + `remainingMs` only, no error type or consecutive count. (`commands.ts:228-232`)

---

## Goal (Definition of Done)

All three slices implemented and verified:

### Slice 1 — SQLite Backend
- [ ] In-memory `Map` replaced with `node:sqlite` (built-in, Node 22+)
- [ ] Database at `~/.local/share/pi/model-router.db` (respects `$XDG_DATA_HOME`)
- [ ] Schema `cooldowns(model_ref TEXT PK, error_type TEXT, expiry_at INTEGER, duration_ms INTEGER, consecutive INTEGER DEFAULT 1 CHECK(consecutive>=1))`
- [ ] `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000` on init
- [ ] Lazy init, module-level singleton via `getDb()`
- [ ] `_setDbForTesting(db?)` for test injection
- [ ] All public APIs synchronous, same surface as today
- [ ] New test file `rate-limit-tracker.test.ts` with `:memory:` SQLite
- [ ] All 57 existing tests pass unchanged

### Slice 2 — Escalating Cooldown
- [ ] `classifyError()` returns string category replacing `isTransientError()` (removed entirely)
- [ ] Error categories: `rate_limit`, `server_error`, `timeout`, `auth`, `other`
- [ ] Escalation tiers: 1-4 → 5m, 5-6 → 1h, 7+ → 6h (cap at consecutive=12)
- [ ] Consecutive counter decoupled from expiry (only resets on different error type or `resetCooldown()`)
- [ ] `markRateLimited(ref, cooldownMs?, errorType?)` — increments on same-type
- [ ] `resetCooldown(ref)` — clears entry entirely
- [ ] Error-after-content: `erredAfterContent` flag in `tryModel`, stream returns `false` instead of `true`
- [ ] Provider-level (`__provider:`) uses `"provider_outage"`, no escalation
- [ ] `/router status` shows error type + consecutive count
- [ ] `isTransientError` removed entirely (no backward compat stub)

### Slice 3 — Manual Testing (HITL)
- [ ] Manual sign-off across multiple terminals

---

## Key Findings (Prova Real)

**From source files** (`extensions/rate-limit-tracker.ts`, `provider.ts`, `constants.ts`, `commands.ts`, `types.ts`, `provider.test.ts`):

1. **Current cooldown API surface** (`rate-limit-tracker.ts`):
   - `isRateLimited(ref): boolean`
   - `markRateLimited(ref, cooldownMs?)`
   - `getActiveRateLimits(): Array<{ ref; remainingMs }>`
   - `clearRateLimits(): void`
   - `getRemainingCooldownMs(ref): number | null`
   - `isTransientError(error): boolean`
   - `isRateLimitError(error): boolean`
   - All synchronous, zero deps, module-level `const RATE_LIMITED = new Map<…>()`

2. **Call sites in provider.ts:**
   - `tryModel()` line 177: `markRateLimited(ref, config.rateLimitCooldownMs)` at error-after-content
   - `routeStream()` line 272-275: `markRateLimited(ref, config.rateLimitCooldownMs)` + `markRateLimited('__provider:' + provider, config.rateLimitCooldownMs)` in catch block
   - `isRateLimitError()` used only for fallback notification prefix (line 280), not for control flow
   - `isTransientError()` is NOT used anywhere in provider.ts — the cooldown gating that `isTransientError` used to guard was removed in the previous feature (error-state-invisibility). So **no current caller will break from removing `isTransientError`**.

3. **Test patterns** (`provider.test.ts`):
   - Uses `vi.mock('@earendil-works/pi-ai/compat')` to mock `streamSimple`
   - Uses `vi.mock('@earendil-works/pi-ai')` to mock `createAssistantMessageEventStream`
   - Helper: `delegatedStream(event)` — single-event stream
   - Helper: `errorAfterContentStream(reason, msg)` — text_delta → error → done
   - Helper: `successStream()` — text_delta → done
   - Helper: `setupRouter(config, registry)` — calls `registerRouterProvider` and returns `streamSimple`
   - `clearRateLimits()` called in `beforeEach`
   - Tests await `stream._endPromise` for async IIFE completion

4. **Current constants** (`constants.ts`):
   - `DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000` (5 min)
   - No tier constants yet

5. **Router status display** (`commands.ts:228-232`):
   - Formats `remainingMs` as minutes/seconds
   - No error type or consecutive count shown

6. **Existing issues** (from `bd list`):
   - `pi-model-router-8gx` — Slice 1: SQLite Backend (`ready-for-agent`)
   - `pi-model-router-xsf` — Slice 2: Escalating Cooldown (`ready-for-agent`)
   - `pi-model-router-2pk` — Slice 3: Manual Testing (`ready-for-human`)

**From review.md** (3 P0 fixes, all already in PRD):
- ✅ **P0#1**: Consecutive counter decoupled from cooldown expiry (PRD "decoupled from cooldown expiry")
- ✅ **P0#2**: `_setDbForTesting()` for SQLite test injection (PRD "Tests use a `:memory:` database injected via `_setDbForTesting(db?)`")
- ✅ **P0#3**: `PRAGMA busy_timeout=5000` on init (PRD "PRAGMA busy_timeout = 5000 on init")
- ✅ **P1#4**: Error-after-content `erredAfterContent` flag (PRD "erredAfterContent flag in tryModel to not return true after error+done")
- ✅ **P1#5**: `isTransientError` deleted, no backward-compat stub (PRD "The old isTransientError is removed entirely")
- ✅ **P2#8**: `CHECK(consecutive >= 1)` (PRD schema has it)
- ✅ **P2#9**: No `updated_at` column (PRD schema doesn't have it)

---

## Authoritative Inputs

| Input | Source | Key Content |
|---|---|---|
| PRD | `docs/prd-cooldown-escalation.md` | Full spec: schema, tiers, API changes, test seams |
| Design review | `.pi/plans/2026-07-06-escalating-cooldown/review.md` | 3 P0 fixes incorporated, architecture validation |
| Codebase | `extensions/rate-limit-tracker.ts` | Current in-memory implementation to rewrite |
| Codebase | `extensions/provider.ts` | Call sites for cooldown + error-after-content |
| Codebase | `extensions/constants.ts` | Existing rate limit constant |
| Codebase | `extensions/commands.ts` | `/router status` display |
| Codebase | `extensions/types.ts` | `RouterConfig` type |
| Codebase | `extensions/provider.test.ts` | Mock patterns, helper functions |
| Project DOX | `AGENTS.md` | DOX framework, closeout requirements |

---

## Changes (Steps)

### Slice 1: SQLite Backend — File Mutations

#### `extensions/rate-limit-tracker.ts` — Rewrite backend, keep API surface

| # | Mutation | Details |
|---|----------|---------|
| 1.1 | Add imports | `DatabaseSync` from `node:sqlite`; `mkdirSync` from `node:fs`; `dirname`, `join` from `node:path`; `homedir` from `node:os` |
| 1.2 | Remove `Map` | Delete `const RATE_LIMITED = new Map<string, number>()` |
| 1.3 | Add state | `let _db: DatabaseSync \| null = null` — module-level connection holder |
| 1.4 | Add `getDbPath()` | Respect `$XDG_DATA_HOME` → fall back to `~/.local/share/pi/`; return `join(dir, 'model-router.db')`; create dir with `0o700` |
| 1.5 | Add `getDb()` | Lazy init: check `_db`, create `new DatabaseSync(getDbPath())`, exec PRAGMAs + `CREATE TABLE IF NOT EXISTS`, return `_db` |
| 1.6 | Add `_setDbForTesting(db?)` | If `db` provided, set `_db = db`; if `null`/undefined, set `_db = null` (closes connection) |
| 1.7 | Rewrite `isRateLimited(ref)` | `SELECT expiry_at FROM cooldowns WHERE model_ref = ?` — compare `expiry_at` vs `Date.now()`, lazily delete expired |
| 1.8 | Rewrite `markRateLimited(ref, cooldownMs?)` | `INSERT OR REPLACE INTO cooldowns(model_ref, error_type, expiry_at, duration_ms, consecutive) VALUES(?, 'other', ?, ?, 1)` — defaults error_type='other', consecutive=1 |
| 1.9 | Rewrite `getActiveRateLimits()` | `SELECT model_ref, expiry_at FROM cooldowns WHERE expiry_at > ?` | 
| 1.10 | Rewrite `clearRateLimits()` | `DELETE FROM cooldowns` |
| 1.11 | Rewrite `getRemainingCooldownMs(ref)` | `SELECT expiry_at FROM cooldowns WHERE model_ref = ?` |
| 1.12 | Keep `isTransientError()` | No change — still boolean, still exported, still used by provider.ts |
| 1.13 | Keep `isRateLimitError()` | No change |
| 1.14 | Add `classifyError(error)` | Returns `'rate_limit' \| 'server_error' \| 'timeout' \| 'auth' \| 'other'` — new export, not yet consumed by provider.ts |

#### `extensions/rate-limit-tracker.test.ts` — NEW file (unit tests)

| # | Test | Verifies |
|---|------|----------|
| 1.15 | `classifyError('429 Too Many Requests')` returns `'rate_limit'` | Error classification |
| 1.16 | `classifyError('502 Bad Gateway')` returns `'server_error'` | Error classification |
| 1.17 | `classifyError('timeout reading response')` returns `'timeout'` | Error classification |
| 1.18 | `classifyError('401 Unauthorized')` returns `'auth'` | Error classification |
| 1.19 | `classifyError('Model not found')` returns `'other'` | Error classification |
| 1.20 | `markRateLimited` + `isRateLimited` roundtrip via `:memory:` SQLite | Basic CRUD |
| 1.21 | `isRateLimited` returns false after expiry | Expiry check |
| 1.22 | `getActiveRateLimits` returns only non-expired | Active filter |
| 1.23 | `clearRateLimits` deletes all rows | Clear operation |
| 1.24 | `getRemainingCooldownMs` returns correct value | Remaining time |
| 1.25 | Multiple models tracked independently | Isolation |
| 1.26 | `_setDbForTesting(null)` resets to null | Test injection |
| 1.27 | All 57 existing tests still pass (`npm test`) | Regression |

NOTE: Each test creates its own `:memory:` database via `_setDbForTesting(new DatabaseSync(':memory:'))` in `beforeEach` and clears it in `afterEach`. This ensures test isolation even with parallel execution.

### Slice 2: Escalating Cooldown — File Mutations

#### `extensions/rate-limit-tracker.ts` — Add escalation logic, change API

| # | Mutation | Details |
|---|----------|---------|
| 2.1 | Remove `isTransientError()` | Delete entirely. No backward-compat stub. `classifyError()` is the replacement. |
| 2.2 | Change `markRateLimited(ref, cooldownMs?, errorType?)` | New signature: `markRateLimited(ref: string, cooldownMs?: number, errorType?: string)`. Logic: query existing entry → if same error_type AND still active → increment consecutive, compute escalated duration from new consecutive; if different error_type → reset consecutive=1. Always set `error_type` to provided value or `'other'`. |
| 2.3 | Add `resetCooldown(ref)` | `DELETE FROM cooldowns WHERE model_ref = ?` — clears entry entirely. Safe to call on non-existent ref (no-op). |
| 2.4 | Add escalation tier logic (`computeCooldownMs(consecutive)`) | Private function: `1-4 → 300000, 5-6 → 3600000, 7+ → 21600000`. Used by `markRateLimited` after incrementing. |
| 2.5 | Update `getActiveRateLimits()` return type | Return `Array<{ ref: string; remainingMs: number; errorType: string; consecutive: number }>` — add `errorType` and `consecutive` from SQL row. |

#### `extensions/constants.ts` — Add tier constants

| # | Mutation | Details |
|---|----------|---------|
| 2.6 | Add `ESCALATION_TIER_1_MAX = 4` | Max consecutive before tier 2 |
| 2.7 | Add `ESCALATION_TIER_2_MIN = 5` | 1h tier start |
| 2.8 | Add `ESCALATION_TIER_2_MAX = 6` | Max consecutive before tier 3 |
| 2.9 | Add `ESCALATION_TIER_3_MIN = 7` | 6h tier start (cap) |
| 2.10 | Add `ESCALATION_COOLDOWN_TIER_1_MS = 300_000` | 5 min (same as `DEFAULT_RATE_LIMIT_COOLDOWN_MS`) |
| 2.11 | Add `ESCALATION_COOLDOWN_TIER_2_MS = 3_600_000` | 1 hour |
| 2.12 | Add `ESCALATION_COOLDOWN_TIER_3_MS = 21_600_000` | 6 hours |
| 2.13 | Keep `DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000` | Still used for provider-level cooldown (no escalation). Document as "base tier, not used for escalation logic." |

#### `extensions/provider.ts` — Update call sites

| # | Mutation | Details |
|---|----------|---------|
| 2.14 | Change import | Replace `isTransientError` with `classifyError`. Add `resetCooldown` to import. |
| 2.15 | `tryModel()` — classify error | At error-before-content catch site: `const errType = classifyError(err)` → pass to `markRateLimited(ref, config.rateLimitCooldownMs, errType)` |
| 2.16 | `tryModel()` — error-after-content flag | Add `let erredAfterContent = false` before stream iteration. On `event.type === 'error'` with `contentReceived === true`, set `erredAfterContent = true`. |
| 2.17 | `tryModel()` — error-after-content mark | Currently line 177: `markRateLimited(ref, config.rateLimitCooldownMs)`. Change to: `const errType = classifyError(event.error.errorMessage); markRateLimited(ref, config.rateLimitCooldownMs, errType);` |
| 2.18 | `tryModel()` — done event check | On `event.type === 'done'`, check `erredAfterContent`: if true, call `stream.end()` + return `false` (failure). If false (clean success), call `resetCooldown(ref)` + `stream.end()` + return `true`. |
| 2.19 | `routeStream()` catch block — model-level mark | Line 272: change to `const errType = classifyError(lastError); markRateLimited(ref, config.rateLimitCooldownMs, errType);` |
| 2.20 | `routeStream()` catch block — provider-level mark | Line 275: change to `markRateLimited('__provider:' + resolved.provider, config.rateLimitCooldownMs, 'provider_outage');` — always uses `'provider_outage'` error type, no escalation. |

#### `extensions/commands.ts` — Update `/router status`

| # | Mutation | Details |
|---|----------|---------|
| 2.21 | Update status display | `getActiveRateLimits()` now returns `{ ref, remainingMs, errorType, consecutive }`. Format: `` `${ref} — ${cooldownStr} remaining (${errorType}, consecutive: ${consecutive})` `` with a suffix showing the current tier e.g. `→ 1h tier` or `→ 6h tier` at consecutive≥5 or 7+. |

#### `extensions/provider.test.ts` — Add escalation tests

| # | Test | Verifies ISC |
|---|------|-------------|
| 2.22 | Same-type error 5x → cooldown escalates to 1h | Escalation tier 2 |
| 2.23 | Same-type error 7x → cooldown escalates to 6h (cap) | Escalation tier 3 |
| 2.24 | Different error types → counter resets, stays at 5m | Counter isolation |
| 2.25 | Success after cooldown → `resetCooldown` clears escalation | Success reset |
| 2.26 | Error-after-content → stream returns failure (not success) | `erredAfterContent` flag |
| 2.27 | Provider-level cooldown (`provider_outage`) does NOT escalate | Provider isolation |
| 2.28 | Spaced-out errors (cooldown expires, then same error) → increments counter | Decoupled counter |

#### `extensions/rate-limit-tracker.test.ts` — Add escalation unit tests

| # | Test | Verifies |
|---|------|----------|
| 2.29 | `markRateLimited` with same error type → increments consecutive | Counter increment |
| 2.30 | `markRateLimited` with different error type → resets consecutive=1 | Counter reset |
| 2.31 | `resetCooldown` clears entry, next mark starts at consecutive=1 | Reset |
| 2.32 | Consecutive cap at 12 (13th mark → still 12) | Max cap |
| 2.33 | Expired entry + same-type mark → increments from existing consecutive | Decoupled from expiry |

### Slice 3: Manual Testing & Sign-off

| # | Step | Details |
|---|------|---------|
| 3.1 | Build & install | `npm run build` (if applicable), verify extension loads in pi |
| 3.2 | Terminal A — simulate errors | Configure a router with a model that returns errors. Verify cooldown appears in `/router status` with correct error type + consecutive |
| 3.3 | Terminal B — verify cross-session | Same machine, second terminal. Run `/router status` — cooldown state should match. |
| 3.4 | Escalation verification | Trigger 5 same-type errors (simulate by sending messages rapidly). Verify cooldown duration increases. |
| 3.5 | `/router clearcache` | Verify all cooldowns cleared |
| 3.6 | `npm test` | All tests pass (existing + new) |

---

## Task List

### Slice 1 Tasks (AFK, `ready-for-agent`)

**Task 1.1: Rewrite rate-limit-tracker.ts with SQLite backend**

Tags: `slice-1`, `ready-for-agent`
Body:
- Files: `extensions/rate-limit-tracker.ts`, `extensions/types.ts`
- Rewrite the module to use `node:sqlite` (built-in `DatabaseSync`) instead of `Map<string, number>`
- Add lazy init with getDb() — module-level singleton
- Add `_setDbForTesting(db?)` — test-only setter that overrides the module-level connection
- Add `getDbPath()` — respects `$XDG_DATA_HOME`, falls back to `~/.local/share/pi/`
- Schema: `cooldowns(model_ref TEXT PRIMARY KEY, error_type TEXT NOT NULL, expiry_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, consecutive INTEGER DEFAULT 1 CHECK(consecutive >= 1))`
- PRAGMAs: `journal_mode=WAL`, `busy_timeout=5000`
- All existing public API functions keep same signatures and return types:
  - `isRateLimited(ref): boolean`
  - `markRateLimited(ref, cooldownMs?)` — INSERT OR REPLACE with default error_type='other', consecutive=1
  - `getActiveRateLimits(): Array<{ ref; remainingMs }>`
  - `clearRateLimits(): void`
  - `getRemainingCooldownMs(ref): number | null`
- Keep `isTransientError()` and `isRateLimitError()` unchanged
- Add new `classifyError(error): 'rate_limit' | 'server_error' | 'timeout' | 'auth' | 'other'` export (not yet used by provider.ts)
- **Do NOT** change any call sites in provider.ts — that's Slice 2
- **Do NOT** add escalation logic — that's Slice 2
- Accept the full path of the plan artifact so workers can reference it

Code example — new structure:
```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from './constants'

let _db: DatabaseSync | null = null

function getDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, 'pi')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'model-router.db')
}

function getDb(): DatabaseSync {
  if (_db) return _db
  _db = new DatabaseSync(getDbPath())
  _db.exec('PRAGMA journal_mode=WAL')
  _db.exec('PRAGMA busy_timeout=5000')
  _db.exec(`CREATE TABLE IF NOT EXISTS cooldowns (
    model_ref     TEXT PRIMARY KEY,
    error_type    TEXT NOT NULL,
    expiry_at     INTEGER NOT NULL,
    duration_ms   INTEGER NOT NULL,
    consecutive   INTEGER DEFAULT 1 CHECK(consecutive >= 1)
  )`)
  return _db
}

export function _setDbForTesting(db?: DatabaseSync | null): void {
  _db = db ?? null
}

export function isRateLimited(ref: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT expiry_at FROM cooldowns WHERE model_ref = ?').get(ref) as { expiry_at: number } | undefined
  if (!row) return false
  if (Date.now() >= row.expiry_at) {
    db.prepare('DELETE FROM cooldowns WHERE model_ref = ?').run(ref)
    return false
  }
  return true
}

// ... same pattern for other functions
```

**Task 1.2: Create rate-limit-tracker.test.ts**

Tags: `slice-1`, `ready-for-agent`
Body:
- Files: `extensions/rate-limit-tracker.test.ts` (NEW)
- Unit tests for `rate-limit-tracker.ts` using `:memory:` SQLite
- Each test creates its own db in `beforeEach` via `_setDbForTesting(new DatabaseSync(':memory:'))`
- Tests cover:
  1. `classifyError('429 Too Many Requests')` → `'rate_limit'`
  2. `classifyError('502 Bad Gateway')` → `'server_error'`
  3. `classifyError('timeout reading response')` → `'timeout'`
  4. `classifyError('401 Unauthorized')` → `'auth'`
  5. `classifyError('Model not found')` → `'other'`
  6. `markRateLimited` + `isRateLimited` roundtrip
  7. `isRateLimited` returns false after expiry
  8. `getActiveRateLimits` returns only non-expired
  9. `clearRateLimits` deletes all
  10. `getRemainingCooldownMs` returns correct value
  11. Multiple models tracked independently
  12. `_setDbForTesting(null)` resets state
- Reference: existing test patterns in `provider.test.ts` (mocking, setup patterns)
- Reference: plan artifact at `.pi/plans/2026-07-06-escalating-cooldown/plan.md`

**Task 1.3: Verify all existing tests still pass**

Tags: `slice-1`, `ready-for-agent`
Body:
- Run `npm test` — all 57 existing tests must pass
- The SQLite backend rewrite must not change behavior visible to existing tests
- Key regression check: `clearRateLimits()` in provider.test.ts `beforeEach` still works (uses SQLite DELETE now)
- Fix any test failures by adjusting the SQLite implementation (NOT by changing existing tests)

### Slice 2 Tasks (AFK, `ready-for-agent`)

**Task 2.1: Add escalation constants to constants.ts**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/constants.ts`
- Add these exports:
  ```ts
  export const ESCALATION_TIER_1_MAX = 4
  export const ESCALATION_TIER_2_MIN = 5
  export const ESCALATION_TIER_2_MAX = 6
  export const ESCALATION_TIER_3_MIN = 7
  export const ESCALATION_COOLDOWN_TIER_1_MS = 300_000
  export const ESCALATION_COOLDOWN_TIER_2_MS = 3_600_000
  export const ESCALATION_COOLDOWN_TIER_3_MS = 21_600_000
  ```
- Keep existing `DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000` — used for provider-level cooldown (no escalation). Add comment: "Base tier duration. Escalation logic uses ESCALATION_COOLDOWN_* constants."

**Task 2.2: Add escalation logic to rate-limit-tracker.ts**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/rate-limit-tracker.ts`
- Remove `isTransientError()` entirely — no backward compat stub
- Change `markRateLimited(ref, cooldownMs?, errorType?)`:
  - Query existing entry by `model_ref`
  - If existing entry found AND same `error_type` AND still active (`expiry_at > now`):
    - Increment `consecutive` (cap at 12)
    - Compute escalated cooldown from `computeCooldownMs(consecutive)`
    - UPDATE the row with new `expiry_at`, `duration_ms`, `consecutive`
  - If existing entry found AND different `error_type` OR not active:
    - Reset `consecutive = 1`
    - Use provided `cooldownMs` (base duration)
    - INSERT OR REPLACE
  - If no existing entry:
    - INSERT with `consecutive = 1`, `error_type = errorType ?? 'other'`
- Add `computeCooldownMs(consecutive: number): number`:
  ```ts
  function computeCooldownMs(consecutive: number): number {
    if (consecutive >= 7) return ESCALATION_COOLDOWN_TIER_3_MS       // 6h
    if (consecutive >= 5) return ESCALATION_COOLDOWN_TIER_2_MS       // 1h
    return ESCALATION_COOLDOWN_TIER_1_MS                               // 5m
  }
  ```
  - Cap `consecutive` at max 12 before computing: `consecutive = Math.min(consecutive, 12)`
- Add `resetCooldown(ref: string): void`:
  ```ts
  export function resetCooldown(ref: string): void {
    const db = getDb()
    db.prepare('DELETE FROM cooldowns WHERE model_ref = ?').run(ref)
  }
  ```
- Update `getActiveRateLimits()` return type to `Array<{ ref: string; remainingMs: number; errorType: string; consecutive: number }>`:
  - SELECT `model_ref, expiry_at, error_type, consecutive` FROM cooldowns WHERE expiry_at > ?
  - Map snake_case columns to camelCase in result
- Update `getRemainingCooldownMs(ref)` to also lazily clean expired entries (same pattern as `isRateLimited`)
- Reference: plan artifact at `.pi/plans/2026-07-06-escalating-cooldown/plan.md`

**Task 2.3: Update provider.ts call sites for classifyError + resetCooldown**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/provider.ts`
- Import changes:
  - Remove `isTransientError` from import (no longer exists)
  - Add `classifyError` and `resetCooldown` to import
  - Keep `isRateLimitError` (used for fallback notification prefix)
- In `tryModel()` (around line 150-180):
  - Add `let erredAfterContent = false` before stream iteration
  - On `event.type === 'error'` with `contentReceived === true`: classify the error, pass to `markRateLimited(ref, config.rateLimitCooldownMs, errType)`, set `erredAfterContent = true`
  - On `event.type === 'done'`: if `erredAfterContent`, call `stream.end()` and return `false`; if clean success, call `resetCooldown(ref)`, then `stream.end()` and return `true`
- In `routeStream()` catch block (around line 265-275):
  - Model-level: `const errType = classifyError(lastError); markRateLimited(ref, config.rateLimitCooldownMs, errType);`
  - Provider-level: `markRateLimited('__provider:' + resolved.provider, config.rateLimitCooldownMs, 'provider_outage');`
- Error-before-content throw in `tryModel()` (line ~135-138): the catch in `routeStream` will handle classification — no change needed in the throw path
- **Do NOT change** the `isRateLimitError` usage — it's only used for fallback notification prefix, not for cooldown control flow
- Reference: plan artifact at `.pi/plans/2026-07-06-escalating-cooldown/plan.md`

**Task 2.4: Update /router status display in commands.ts**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/commands.ts`
- `getActiveRateLimits()` now returns `{ ref, remainingMs, errorType, consecutive }` objects
- Update status display (line ~228-232) to show error type + consecutive count + tier:
  ```ts
  for (const { ref, remainingMs, errorType, consecutive } of limits) {
    const mins = Math.floor(remainingMs / 60_000)
    const secs = Math.ceil((remainingMs % 60_000) / 1000)
    const remaining = mins >= 1 ? `${mins}m ${secs}s` : `${secs}s`
    let tierLabel = '→ 5m tier'
    if (consecutive >= 7) tierLabel = '→ 6h tier'
    else if (consecutive >= 5) tierLabel = '→ 1h tier'
    lines.push(`  ${ref} — ${remaining} remaining (${errorType}, consecutive: ${consecutive} ${tierLabel})`)
  }
  ```
- Reference: plan artifact at `.pi/plans/2026-07-06-escalating-cooldown/plan.md`

**Task 2.5: Add escalation tests to provider.test.ts**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/provider.test.ts`
- Add tests using the same mock patterns (`delegatedStream`, `errorAfterContentStream`, `successStream`, `setupRouter`):
  1. Same-type error 5x across sequential `streamSimple` calls → verify cooldown escalates to 1h (use `getActiveRateLimits()` after 5th call — expect `remainingMs > 300000`)
  2. Same-type error 7x → verify cooldown escalates to 6h (`remainingMs > 3600000`)
  3. Different error types (1st call returns `'429'` error, 2nd call returns `'401'` error) → consecutive resets, stays at 5m tier
  4. Error-after-content + done event → verify `tryModel` returns `false` (stream does NOT call `resetCooldown`, cooldown entry exists)
  5. Error-after-content → verify `resetCooldown` is NOT called on done (entry stays)
  6. Success (no error) → verify `resetCooldown` is called (entry cleared or starts fresh)
- Reference: existing test patterns in `provider.test.ts` — use the same helpers (`delegatedStream`, `errorAfterContentStream`, `successStream`, `setupRouter`)
- Reference: plan artifact at `.pi/plans/2026-07-06-escalating-cooldown/plan.md`

**Task 2.6: Add escalation unit tests to rate-limit-tracker.test.ts**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/rate-limit-tracker.test.ts`
- Add tests:
  1. `markRateLimited('ref', 300000, 'rate_limit')` 5x → each call increments consecutive, 5th call has escalated cooldown
  2. `markRateLimited('ref', 300000, 'auth')` then `markRateLimited('ref', 300000, 'rate_limit')` → consecutive resets to 1
  3. `resetCooldown('ref')` → next `markRateLimited` starts at consecutive=1
  4. Consecutive cap test: mark 15x with same error → consecutive stays at 12 after 12th
  5. Expired entry test: set short cooldown, wait for expiry, mark with same error type → consecutive increments from stored value
  6. `computeCooldownMs` tier boundaries: consecutive=1 → 5m, consecutive=5 → 1h, consecutive=7 → 6h, consecutive=12 → 6h (cap)
- Use `vi.useFakeTimers()` for time-sensitive tests (expiry)

**Task 2.7: Run full test suite and fix regressions**

Tags: `slice-2`, `ready-for-agent`
Body:
- Run `npm test` — verify all tests pass (existing + new)
- Pay special attention to:
  - `RouterAbortError` should NOT trigger cooldown (existing test)
  - Provider-level cooldown should still work with new `'provider_outage'` error type
  - `errorAfterContent` tests should still pass with new `erredAfterContent` flag logic
  - `resetCooldown` on success should not break the existing error-before-content cooldown tests

**Task 2.8: Update docs for type change**

Tags: `slice-2`, `ready-for-agent`
Body:
- Files: `extensions/types.ts` (if needed), `README.md` (if needed)
- If `RouterConfig` type needs documentation about `rateLimitCooldownMs` being the base tier, update the type comment
- Add a note in README (if applicable) about the SQLite dependency (Node 22+)
- No code changes — just docs

### Slice 3 Tasks (HITL, `ready-for-human`)

**Task 3.1: Manual testing and sign-off**

Tags: `slice-3`, `ready-for-human`
Body:
- Build and install the extension
- Follow manual test plan:
  1. Verify `/router status` shows correct cooldown info with error type + consecutive + tier
  2. Verify cross-session persistence (two terminals sharing cooldown state)
  3. Verify escalation by triggering multiple same-type errors
  4. Verify `/router clearcache` clears all
  5. Verify cooldown survives pi restart

---

## Verification Plan

### Per-Slice Verification

| Slice | Verification Method | Command |
|-------|-------------------|---------|
| 1 | All 57 existing tests pass | `npm test` |
| 1 | New unit tests pass (classifyError, SQLite CRUD) | `npx vitest run extensions/rate-limit-tracker.test.ts` |
| 2 | All tests pass (old + new) | `npm test` |
| 2 | Escalation tier transitions correct | `npx vitest run -t 'escalat'` |
| 2 | `isTransientError` no longer exported | `grep -r 'isTransientError' extensions/` (should only appear in old docs) |
| 3 | Manual sign-off across terminals | HITL |

### Regression Guard

- `RouterAbortError` must NOT trigger cooldown (test exists, must pass)
- Error-before-content must still trigger cooldown (test exists, must pass)
- Provider-level cooldown must still work (test exists, must pass)
- `clearRateLimits()` must still clear everything (used in tests)

### Closeout (DOX pass)

After all slices:
1. Check changed paths against DOX chain: `AGENTS.md` root + `docs/` scope
2. Update nearest owning docs if any contract changed
3. Verify all test files exist and pass
4. Report any docs intentionally left unchanged and why

---

## Halt for Approval

Before implementation begins, review this plan and confirm:

1. **Slice ordering**: SQLite backend first (Slice 1), escalation logic second (Slice 2), manual sign-off third (Slice 3)
2. **API surface changes**: `markRateLimited` signature changes in Slice 2, `isTransientError` removed
3. **Schema**: `consecutive` with CHECK constraint, no `updated_at` column
4. **Test strategy**: `:memory:` SQLite per test for isolation, existing tests must not change behavior

Review and approve to proceed with implementation.
