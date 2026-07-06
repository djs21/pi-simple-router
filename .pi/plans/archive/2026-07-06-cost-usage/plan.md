# Plan: Cost & Usage Tracking

**Date:** 2026-07-06
**Status:** Draft
**Directory:** `/home/djs/project/pi-model-router`
**Source PRD:** `docs/prd-cost-usage.md`
**Scout report:** `.pi/plans/2026-07-06-cost-usage/scout-report.md`
**Issues:** `pi-model-router-iu2` (Slice 1), `pi-model-router-jat` (Slice 2), `pi-model-router-wue` (Slice 3)

---

## Context / Problem Statement

The router extension delegates to real provider models (OpenAI, Anthropic, etc.) but has **no visibility into the cost or token usage** of those delegations. Three blind spots:

1. **No per-request cost data** — `delegatedStream.result().usage` is discarded after delegation. Users have no idea what each request costs.
2. **No historical tracking** — no persistent record of which models were used, how many tokens consumed, or cost over time.
3. **No cleanup mechanism** — accumulated data has no way to be pruned.

**Evidence from codebase:**
- `extensions/provider.ts:createEmptyMessage()` hardcodes `usage: { input: 0, output: 0, ... }` — all zeros. (`scout-report.md` gotcha #1)
- `delegatedStream.result().usage` is never read after the stream completes. (`scout-report.md` slide 1)
- `rate-limit-tracker.ts` has `getDb()` as a module-private function — currently unexportable. (`scout-report.md` slide 2)
- The `rate-limit-tracker.test.ts` has the `_setDbForTesting` seam pattern to follow. (`scout-report.md` slide 2)
- 57+ existing tests pass, provider tests mock `streamSimple` via `vi.mock()`. (`provider.test.ts` patterns)

---

## Goal (Definition of Done)

All four slices implemented and verified:

### Slice 1 — SQLite Usage Table + Capture at 3 Points (Blocking)
- [ ] `getDb()` exported from `rate-limit-tracker.ts` for reuse
- [ ] New `extensions/usage-tracker.ts` with `recordUsage()`, `queryUsage()`, `cleanupUsage()`, `_setDbForTesting()`
- [ ] Creates `usage` table + indexes on init (reuses `getDb()` singleton)
- [ ] Capture at 3 points in `provider.ts`: success, error-after-content, error-before-content
- [ ] All capture wrapped in try-catch (non-blocking, fire-and-forget)
- [ ] `CLEANUP_INTERVALS` and `USAGE_TABLE_NAME` added to `constants.ts`
- [ ] New `usage-tracker.test.ts` with hermetic tests (`:memory:` DB)

### Slice 2 — Footer Cost Auto-Accumulation (flows through delegated stream events)
- [ ] Success path: `response.result()` resolves with inner provider's message (has real usage) → footer shows real cost automatically
- [ ] Error-after-content path: inner provider's error `AssistantMessage` may carry partial usage → footer shows it if present
- [ ] Error-before-content path: no usage available → footer stays at zeros (no content produced)
- [ ] Verified in HITL that footer shows correct cost without `output.usage` assignment

### Slice 3 — Commands + Manual Testing
- [ ] `/router cost [router_name] [--since 24h|1w|1m|2m|all]` — formatted table with aggregation
- [ ] `/router cleanup 24h|1w|1m|2m|all` — delete old records, returns count
- [ ] Manual sign-off in pi

---

## Authoritative Inputs

| Input | Source | Key Content |
|---|---|---|
| PRD | `docs/prd-cost-usage.md` | Full spec: schema, capture points, commands, test seams |
| Scout report | `.pi/plans/2026-07-06-cost-usage/scout-report.md` | Codebase layout, `getDb()` private, `createEmptyMessage` zeros, call sites |
| Issues | `bd show pi-model-router-iu2\|jat\|wue` | 3 issues, dependency chain, task breakdown |
| Codebase | `extensions/provider.ts` | `tryModel()` lines 139–247, `routeStream()` lines 285–430, `createEmptyMessage` |
| Codebase | `extensions/rate-limit-tracker.ts` | `getDb()` private at line 28, `_setDbForTesting` exported |
| Codebase | `extensions/commands.ts` | Subcommand dispatch at line 155, autocomplete patterns |
| Codebase | `extensions/constants.ts` | Existing constant exports |
| Codebase | `extensions/types.ts` | `RouterConfig`, `CustomModelConfig` types |
| Codebase | `extensions/provider.test.ts` | Mock patterns, `delegatedStream()` helper, `setupRouter()` |
| Codebase | `extensions/rate-limit-tracker.test.ts` | `:memory:` SQLite test patterns |
| Project DOX | `AGENTS.md` | DOX framework, closeout requirements |

---

## Key Design Decisions

1. **Export `getDb()` from `rate-limit-tracker.ts`** — simplest reuse path. No new database module, no second connection. Single `DatabaseSync` instance shared between cooldowns and usage tables. The `_setDbForTesting()` seam works for both tables via the same injection. (`ponytail: no new db module, reuse established singleton`)

2. **Usage capture is fire-and-forget** — wrapped in try-catch. If `delegatedStream.result()` throws or usage is null/undefined, skip silently. The router must never fail a request because usage tracking failed.

3. **Footer cost flows through delegated stream events** — pi reads the final `AssistantMessage` via `await response.result()` from `agent-loop.js`. The delegated stream's `done` event carries the inner provider's message with real usage, which is pushed to the outer router stream. `result()` resolves with this message, so the footer shows actual costs automatically.

4. **Error-before-content skips footer** — no content was produced, so footer should not show cost for a failed request. Usage is still recorded to DB (for historical tracking), but `output.usage` stays at zeros.

**Verification:** See `.pi/plans/2026-07-06-cost-usage/review.md` → "Appendix A: Footer Mechanism Verification" for the SDK analysis of `stream.end()`, `response.result()`, and how usage flows from delegated to outer stream.

---

## Changes (Per-Slice Steps)

### Batch 1 (Parallel — No Dependencies)

#### Task 1.1: Export `getDb()` from `rate-limit-tracker.ts`

**File:** `extensions/rate-limit-tracker.ts` — one-line change

| # | Mutation | Details |
|---|----------|---------|
| 1.1.1 | Change `function getDb()` to `export function getDb()` | Line ~28: prepend `export` to the `getDb` function declaration. This makes it importable by `usage-tracker.ts` while keeping all existing internal callers working unchanged. |

**Test impact:** No behavior change. All existing tests pass unchanged.

**Scope guard:** Do NOT change any other function. Do NOT refactor. Do NOT add or remove any other exports.

---

#### Task 1.2: Create `extensions/usage-tracker.ts`

**File:** `extensions/usage-tracker.ts` (NEW)

A self-contained module following the same SQLite singleton pattern as `rate-limit-tracker.ts`.

**Exports:**

| Export | Signature | Description |
|--------|-----------|-------------|
| `recordUsage` | `(routerRef: string, modelRef: string, usage: UsageObject, timestamp?: number): void` | INSERT row into `usage` table. Uses `getDb()` singleton. All fields default to 0. |
| `queryUsage` | `(opts: { routerRef?: string; since?: number }): UsageRow[]` | SELECT from `usage` with optional filters. Returns array of typed rows. |
| `cleanupUsage` | `(before: number): number` | DELETE rows older than `before` unix ms. Returns count of deleted rows. |
| `_setDbForTesting` | `(db?: DatabaseSync \| null): void` | Testing seam: inject `:memory:` database. Same pattern as rate-limit-tracker. |

**Imports:**
```ts
import { DatabaseSync } from 'node:sqlite'
import { getDb, _setDbForTesting } from './rate-limit-tracker'
import { USAGE_TABLE_NAME, CLEANUP_INTERVALS } from './constants'
// note: _setDbForTesting is re-exported as-is, no need to duplicate
```

**Schema (created lazily inside a shared init function or inside `getDb`'s init block):**

Since `usage-tracker.ts` reuses `getDb()` from `rate-limit-tracker.ts`, and `getDb()` already runs CREATE TABLE for `cooldowns`, we need the `usage` table to also be created. The cleanest approach: add the `usage` table creation to the existing `getDb()` in `rate-limit-tracker.ts` (since `getDb()` is now shared). 

**Alternative (preferred for separation of concerns):** Have `usage-tracker.ts` call a lazy init function that creates the usage table on first use, using the shared `getDb()`:

```ts
let _initialized = false

function ensureTable(): void {
  if (_initialized) return
  const db = getDb()
  db.exec(`CREATE TABLE IF NOT EXISTS ${USAGE_TABLE_NAME} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    router_ref    TEXT NOT NULL,
    model_ref     TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    total_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_input    REAL NOT NULL DEFAULT 0,
    cost_output   REAL NOT NULL DEFAULT 0,
    cost_total    REAL NOT NULL DEFAULT 0,
    timestamp     INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ${USAGE_TABLE_NAME}(timestamp)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_router_ref ON ${USAGE_TABLE_NAME}(router_ref)`)
  _initialized = true
}
```

**Ponytail:** Table creation in the shared `getDb()` keeps init centralized and visible. But it couples concerns. The lazy `ensureTable()` in `usage-tracker.ts` is also fine — just one extra check per call. Both work. I'd recommend adding the CREATE TABLE to `getDb()` in `rate-limit-tracker.ts` since it's now the shared connection owner.

**Decision: Add usage table creation to `getDb()` in `rate-limit-tracker.ts`.** This keeps the shared connection's schema initialization in one place.

**`recordUsage` implementation:**
```ts
export function recordUsage(
  routerRef: string,
  modelRef: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } },
  timestamp?: number,
): void {
  try {
    ensureTable()
    const db = getDb()
    const now = timestamp ?? Date.now()
    const toNum = (v: unknown): number => (typeof v === 'number' ? v : 0)
    db.prepare(
      `INSERT INTO ${USAGE_TABLE_NAME} 
       (router_ref, model_ref, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_input, cost_output, cost_total, timestamp)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      routerRef,
      modelRef,
      toNum(usage.input),
      toNum(usage.output),
      toNum(usage.cacheRead),
      toNum(usage.cacheWrite),
      toNum(usage.totalTokens),
      toNum(usage.cost?.input),
      toNum(usage.cost?.output),
      toNum(usage.cost?.total),
      now,
    )
  } catch {
    // fire-and-forget — never fail the request
  }
}
```

**`queryUsage` implementation:**
```ts
export function queryUsage(opts?: { routerRef?: string; since?: number }): UsageRow[] {
  ensureTable()
  const db = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts?.routerRef) {
    conditions.push('router_ref = ?')
    params.push(opts.routerRef)
  }
  if (opts?.since) {
    conditions.push('timestamp >= ?')
    params.push(opts.since)
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  const rows = db.prepare(
    `SELECT id, router_ref, model_ref, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost_input, cost_output, cost_total, timestamp
     FROM ${USAGE_TABLE_NAME}${where} ORDER BY timestamp DESC`,
  ).all(...params) as UsageRowRaw[]

  return rows.map(mapRow)
}
```

**`cleanupUsage` implementation:**
```ts
export function cleanupUsage(before: number): number {
  ensureTable()
  const db = getDb()
  const result = db.prepare(
    `DELETE FROM ${USAGE_TABLE_NAME} WHERE timestamp < ?`,
  ).run(before)
  return Number(result.changes ?? 0)
}
```

**`_setDbForTesting` implementation:**
```ts
// Re-export from rate-limit-tracker for convenience
export { _setDbForTesting } from './rate-limit-tracker'
```

**Type definition** (in `usage-tracker.ts` or `types.ts`):
```ts
export interface UsageRow {
  id: number
  routerRef: string
  modelRef: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costInput: number
  costOutput: number
  costTotal: number
  timestamp: number
}
```

**Ponytail:** Define `UsageRow` interface inline in `usage-tracker.ts` (no new file). Add to `types.ts` only if another module needs it — it won't, because only `commands.ts` imports from `usage-tracker`, and it's fine to import the type alongside the functions.

**Test impact:** New file, no existing test changes needed.

**Scope guard:** Export ONLY `recordUsage`, `queryUsage`, `cleanupUsage`, `_setDbForTesting`. No module-level state beyond `_initialized` flag.

---

#### Task 1.3: Add usage table creation to `getDb()` in `rate-limit-tracker.ts`

**File:** `extensions/rate-limit-tracker.ts`

In the `getDb()` function (line ~34-40), after the `cooldowns` table creation, add the `usage` table creation:

```ts
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
  // Usage tracking table (shared connection, same DB)
  _db.exec(`CREATE TABLE IF NOT EXISTS ${USAGE_TABLE_NAME} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    router_ref    TEXT NOT NULL,
    model_ref     TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    total_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_input    REAL NOT NULL DEFAULT 0,
    cost_output   REAL NOT NULL DEFAULT 0,
    cost_total    REAL NOT NULL DEFAULT 0,
    timestamp     INTEGER NOT NULL
  )`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ${USAGE_TABLE_NAME}(timestamp)`)
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_router_ref ON ${USAGE_TABLE_NAME}(router_ref)`)
  return _db
}
```

Also import `USAGE_TABLE_NAME` from `./constants`:
```ts
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, ESCALATION_TIER_2_MIN, ... , USAGE_TABLE_NAME } from './constants'
```

**Ponytail:** Adding CREATE TABLE to `getDb()` is the simplest place — one init block, no coordination between two lazy inits. The `usage` table is created unconditionally on first DB access, same as `cooldowns`. No migration logic needed.

---

#### Task 1.4: Add constants to `constants.ts`

**File:** `extensions/constants.ts`

Add these exports:
```ts
export const USAGE_TABLE_NAME = 'usage'

export const CLEANUP_INTERVALS: Record<string, number | null> = {
  '24h': 86_400_000,
  '1w': 604_800_000,
  '1m': 2_592_000_000,   // 30 days
  '2m': 5_184_000_000,   // 60 days
  'all': null,             // no time filter
} as const
```

**Ponytail:** Simple constants, no runtime logic. The `CLEANUP_INTERVALS` map is used by the `/router cleanup` command parser.

---

### Batch 2 (Sequential — Depends on Batch 1)

#### Task 2.1: Capture usage at 3 explicit points in `tryModel` (no try-finally)

**File:** `extensions/provider.ts`

**Imports to add:**
```ts
import { recordUsage } from './usage-tracker'
```

**Key constraint — No try-finally.** The try-finally approach causes duplicate rows: `finally` fires before `return`, so `recordUsage` runs twice on the same success path (once in the explicit `done` handler, once in `finally`). The fix: capture at exactly 3 explicit points with no overlapping coverage.

**Capture point 1 — Success (`event.type === 'done'`, no error, ~line 226):**

Add BEFORE `resetCooldown(ref)`:
```ts
if (event.type === 'done') {
  if (erredAfterContent) {
    stream.end();
    return false;
  }
  // Capture 1: success usage — delegatedStream.result() carries inner provider's message
  try {
    const finalMsg = await delegatedStream.result();
    if (finalMsg?.usage) {
      recordUsage(output.model, ref, finalMsg.usage);
    }
  } catch { /* usage unavailable, skip */ }
  resetCooldown(ref);
  stream.end();
  return true;
}
```

`output.model` is the logical router name (e.g. `"orc"`), `ref` is the provider/model ref (e.g. `"openai/gpt-4"`). No new `tryModel` parameter needed.

**Capture point 2 — Error-before-content (`event.type === 'error' && !contentReceived`, ~line 139):**

Add BEFORE the throw:
```ts
if (event.type === 'error' && !contentReceived) {
  // Capture 2: error-before-content — capture BEFORE throw
  try {
    const finalMsg = await delegatedStream.result();
    if (finalMsg?.usage) {
      recordUsage(output.model, ref, finalMsg.usage);
    }
  } catch { /* usage unavailable, skip */ }

  const errMsg = event.error.errorMessage ?? `Model ${ref} failed before sending content`;
  if (event.reason === 'aborted') {
    throw new RouterAbortError(errMsg);
  }
  throw new Error(errMsg);
}
```

Rationale: `delegatedStream.result()` may resolve even after an error event — some providers include partial usage in the error `AssistantMessage`.

**Capture point 3 — Error-after-content (inside `event.type === 'done'`, `erredAfterContent === true`, ~line 220):**

When a model errors after content, it emits the `error` event (setting `erredAfterContent = true`), then emits `done`. In the `done` handler's `erredAfterContent` branch, add capture BEFORE `stream.end()`:
```ts
if (event.type === 'done') {
  if (erredAfterContent) {
    // Capture 3: error-after-content — partial usage from failed stream
    try {
      const finalMsg = await delegatedStream.result();
      if (finalMsg?.usage) {
        recordUsage(output.model, ref, finalMsg.usage);
      }
    } catch { /* usage unavailable, skip */ }
    stream.end();
    return false;
  }
  // ... success path
}
```

**Summary (no duplicates):**

| # | Where | When | What it captures | `output.usage` |
|---|-------|------|-----------------|----------------|
| 1 | `done` handler, `!erredAfterContent` | Before `resetCooldown` + `stream.end()` | Full usage from inner provider | Not set (see footer note below) |
| 2 | `error` handler, `!contentReceived` | Before `throw` | Partial usage if inner provider included it | Not set (no content produced) |
| 3 | `done` handler, `erredAfterContent` | Before `stream.end()` + `return false` | Partial usage from failed stream | Not set (see footer note below) |

**Do NOT set `output.usage`.** See footer mechanism note below.

---

#### Task 2.2: Footer cost flows through delegated stream events (no code change needed)

**This task is awareness-only.** See `.pi/plans/2026-07-06-cost-usage/review.md` → "Appendix A: Footer Mechanism Verification" for the full SDK analysis.

**Key finding:** pi's `agent-loop.js` reads the final message via `await response.result()`, NOT from the `output` variable. The delegated stream's `done`/`error` events carry the inner provider's `AssistantMessage` (with real usage) and are pushed to the outer router stream. `result()` resolves with this inner message, so the footer shows actual costs automatically on the success path.

`output.usage = finalMsg.usage` before `stream.end()` is:
- **Unnecessary for success** — the inner provider's `done` event already carries real usage
- **Harmless if added** — just modifies a local variable pi doesn't read
- **Potentially useful for error paths** — but only if the inner provider includes usage in its error `AssistantMessage`

**Decision: Do NOT add `output.usage = finalMsg.usage`.** Let the delegated stream events flow naturally. The footer gets usage from the final message pi stores in the session, which comes from the inner provider's `AssistantMessage` carried in the `done`/`error` event. HITL (Task 4.1) verifies this.

---

### Batch 3 (Sequential — Depends on Batch 2)

#### Task 3.1: `/router cost` command

**File:** `extensions/commands.ts`

**Add import:**
```ts
import { queryUsage } from './usage-tracker'
```

**Add subcommand handler** in the `handler` function after the existing subcommand chain (around line 255, after `clearcache`):

```ts
if (subcmd === 'cost') {
  // Parse arguments: [router_name] [--since 24h|1w|1m|2m|all]
  const costArgs = parts.slice(1).filter(Boolean)
  let routerRef: string | undefined
  let since: number | undefined

  for (const arg of costArgs) {
    if (arg.startsWith('--since=')) {
      const val = arg.split('=')[1].toLowerCase()
      const ms = CLEANUP_INTERVALS[val]
      if (ms === undefined) {
        ctx.ui.notify(`⚠️ Invalid --since value. Use: 24h, 1w, 1m, 2m, all`, 'warning')
        return
      }
      if (ms !== null) {
        since = Date.now() - ms
      }
    } else if (arg.startsWith('--since')) {
      ctx.ui.notify('⚠️ Use --since=24h format (with equals sign)', 'warning')
      return
    } else {
      routerRef = arg
    }
  }

  const rows = queryUsage({ routerRef, since })
  if (rows.length === 0) {
    ctx.ui.notify('📊 No usage records found.', 'info')
    return
  }

  // Build table
  const lines: string[] = []
  const header = `📊 Usage${routerRef ? ` for "${routerRef}":` : ':'}`
  lines.push(header)
  lines.push('')

  // Group by routerRef if no specific router requested
  if (!routerRef) {
    const grouped = new Map<string, UsageRow[]>()
    for (const row of rows) {
      const list = grouped.get(row.routerRef) ?? []
      list.push(row)
      grouped.set(row.routerRef, list)
    }
    for (const [group, groupRows] of grouped) {
      lines.push(`  ${group}:`)
      lines.push(formatUsageTable(groupRows))
    }
  } else {
    lines.push(formatUsageTable(rows))
  }

  ctx.ui.notify(lines.join('\n'), 'info')
  return
}
```

**Helper function** (add at module level or as module-private):
```ts
function formatUsageTable(rows: UsageRow[]): string {
  const cols: string[] = []
  let totalTokens = 0
  let totalCost = 0

  for (const row of rows) {
    totalTokens += row.totalTokens
    totalCost += row.costTotal
    const costStr = `$${row.costTotal.toFixed(4)}`
    const date = new Date(row.timestamp).toLocaleString()
    cols.push(
      `  ${row.model_ref.padEnd(30)} ${String(row.inputTokens).toLocaleString().padStart(8)} ${String(row.outputTokens).toLocaleString().padStart(8)} ${String(row.totalTokens).toLocaleString().padStart(8)} ${costStr.padStart(10)}  ${date}`,
    )
  }

  const divider = '  ' + '─'.repeat(70)
  const totalCostStr = `$${totalCost.toFixed(4)}`

  return [
    `  ${'Model'.padEnd(30)} ${'Input'.padStart(8)} ${'Output'.padStart(8)} ${'Total'.padStart(8)} ${'Cost'.padStart(10)}  Timestamp`,
    `  ${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)}  ${'─'.repeat(20)}`,
    ...cols,
    divider,
    `  ${'TOTAL'.padEnd(30)} ${' '.repeat(8)} ${' '.repeat(8)} ${String(totalTokens).toLocaleString().padStart(8)} ${totalCostStr.padStart(10)}`,
  ].join('\n')
}
```

**Ponytail:** A simple table formatter. No external table library needed — just string padding. The format matches what users would type in a terminal.

**Add import for `UsageRow` type:**
```ts
import type { UsageRow } from './usage-tracker'
```

**Add autocomplete for cost subcommand** in the `getArgumentCompletions` function:

```ts
if (subcmd === 'cost') {
  // Provide router model names + --since flags
  const config = getMerged()
  const modelNames = Object.keys(config.models)
  return [
    ...modelNames.map(name => ({ value: name, label: name, description: `Filter by router "${name}"` })),
    { value: '--since=24h', label: '--since=24h', description: 'Last 24 hours' },
    { value: '--since=1w', label: '--since=1w', description: 'Last week' },
    { value: '--since=1m', label: '--since=1m', description: 'Last month' },
    { value: '--since=2m', label: '--since=2m', description: 'Last 2 months' },
    { value: '--since=all', label: '--since=all', description: 'All time' },
  ]
}
```

Also update the `SUBCOMMANDS` array:
```ts
{ name: 'cost', description: 'Lihat usage cost history (opsional: nama_router, --since=1w)' },
{ name: 'cleanup', description: 'Hapus usage records lama: 24h, 1w, 1m, 2m, all' },
```

---

#### Task 3.2: `/router cleanup` command

**File:** `extensions/commands.ts`

**Add import:**
```ts
import { cleanupUsage } from './usage-tracker'
```

**Add subcommand handler** after the `cost` handler:

```ts
if (subcmd === 'cleanup') {
  const intervalArg = parts[1]?.toLowerCase()
  if (!intervalArg || !CLEANUP_INTERVALS[intervalArg]) {
    ctx.ui.notify('⚠️ Usage: /router cleanup 24h|1w|1m|2m|all', 'warning')
    return
  }

  const ms = CLEANUP_INTERVALS[intervalArg]
  const before = ms !== null ? Date.now() - ms : Number.MAX_SAFE_INTEGER // "all": unconditional delete
  const deleted = cleanupUsage(before)
  ctx.ui.notify(`🧹 Deleted ${deleted} usage records (${intervalArg} threshold).`, 'info')
  return
}
```

Wait, let me simplify. The `cleanupUsage(before)` takes a timestamp. If `before` is `Date.now()`, it deletes everything older than now. For `all`, we want everything deleted, so `before` should be `Date.now()` (all records have `timestamp < now`). Actually, for `all`, we want ALL records deleted regardless of age. So pass a very large number or just use a separate approach.

**Simpler:** 
- `all` → pass `Date.now() + 1` (deletes all rows since all timestamps are before future)
- `24h` → pass `Date.now() - 86_400_000`
- `1w` → pass `Date.now() - 604_800_000`
- etc.

```ts
if (subcmd === 'cleanup') {
  const intervalArg = parts[1]?.toLowerCase()
  if (!intervalArg || !(intervalArg in CLEANUP_INTERVALS)) {
    ctx.ui.notify('⚠️ Usage: /router cleanup 24h|1w|1m|2m|all', 'warning')
    return
  }

  const ms = CLEANUP_INTERVALS[intervalArg]
  const before = ms !== null ? Date.now() - ms : Number.MAX_SAFE_INTEGER // "all": unconditional delete
  const deleted = cleanupUsage(before)
  ctx.ui.notify(`🧹 Deleted ${deleted} usage records (${intervalArg} threshold).`, 'info')
  return
}
```

**Add autocomplete for cleanup subcommand:**
```ts
if (subcmd === 'cleanup') {
  return [
    { value: '24h', label: '24h', description: 'Older than 24 hours' },
    { value: '1w', label: '1w', description: 'Older than 1 week' },
    { value: '1m', label: '1m', description: 'Older than 1 month' },
    { value: '2m', label: '2m', description: 'Older than 2 months' },
    { value: 'all', label: 'all', description: 'Delete all records' },
  ]
}
```

---

#### Task 3.3: Update help text

**File:** `extensions/commands.ts`

Update `SUBCOMMANDS` array to include `cost` and `cleanup`:

```ts
const SUBCOMMANDS: Array<{
  name: string
  description: string
}> = [
  { name: 'status', description: 'Lihat config aktif + cooldown' },
  { name: 'cd', description: 'Lihat cooldown aktif + eskalasi (alias: cooldown)' },
  { name: 'reload', description: 'Reload config dari file' },
  { name: 'clearcache', description: 'Reset cooldown cache' },
  { name: 'cost', description: 'Lihat usage cost history (opsional: nama_router, --since=1w)' },
  { name: 'cleanup', description: 'Hapus usage records lama: 24h, 1w, 1m, 2m, all' },
  { name: 'help', description: 'Bantuan' },
]
```

---

### Batch 4 (HITL)

#### Task 4.1: Build, install, and manual sign-off

1. Run `npm test` — all tests must pass
2. Run extension in pi (`pi` with router config)
3. Send a message through a router model
4. Verify footer shows real cost (not $0.000)
5. Run `/router cost` — verify records appear with correct tokens and cost
6. Run `/router cost thinker` — verify filtered
7. Run `/router cleanup 24h` — verify deletion count
8. Run `/router cost` again — confirm records deleted

---

## Schema (Usage Table)

```sql
CREATE TABLE IF NOT EXISTS usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  router_ref    TEXT NOT NULL,   -- logical router name, e.g. "orc", "worker"
  model_ref     TEXT NOT NULL,   -- delegated provider/model ref, e.g. "openai/gpt-4"
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_input    REAL NOT NULL DEFAULT 0,
  cost_output   REAL NOT NULL DEFAULT 0,
  cost_total    REAL NOT NULL DEFAULT 0,
  timestamp     INTEGER NOT NULL   -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_router_ref ON usage(router_ref);
```

Added to `getDb()` in `rate-limit-tracker.ts`, same database connection as `cooldowns`.

---

## Task List

### Batch 1 Tasks (Parallel, `ready-for-agent`)

**Task 1.1: Export `getDb()` from rate-limit-tracker.ts**

Tags: `batch-1`, `ready-for-agent`
Body:
- File: `extensions/rate-limit-tracker.ts`
- Change `function getDb()` → `export function getDb()` at line ~28
- Single line change. No other modifications.
- **Anti-pattern:** Do NOT create a new shared db module. Do NOT change any other exports.
- **Acceptance:** `npm test` passes (all existing tests). A worker can verify by importing `getDb` from the module.

**Task 1.2: Add usage table creation to `getDb()` in rate-limit-tracker.ts**

Tags: `batch-1`, `ready-for-agent`
Body:
- File: `extensions/rate-limit-tracker.ts`
- In `getDb()`, after the cooldowns CREATE TABLE, add the usage table + indexes
- Import `USAGE_TABLE_NAME` from `./constants`
- Follow the exact schema from `docs/prd-cost-usage.md` → "SQLite Schema" section
- **Reference:** Plan artifact `.pi/plans/2026-07-06-cost-usage/plan.md` → "Schema" section
- **Anti-pattern:** Do NOT create a new DB connection. Reuse the existing `getDb()` singleton. Do NOT add migration logic.
- **Acceptance:** After change, the table is created on first `getDb()` call. Verify with `npm test` + inspect `model-router.db` schema.

**Task 1.3: Add constants to constants.ts**

Tags: `batch-1`, `ready-for-agent`
Body:
- File: `extensions/constants.ts`
- Add `USAGE_TABLE_NAME = 'usage'` (string)
- Add `CLEANUP_INTERVALS` map (Record<string, number | null>)
- Follow the exact values from `docs/prd-cost-usage.md` → "New Constants" section
- **Acceptance:** Imports resolve, values match spec.

**Task 1.4: Create usage-tracker.ts**

Tags: `batch-1`, `ready-for-agent`
Body:
- File: `extensions/usage-tracker.ts` (NEW)
- Self-contained module exporting: `recordUsage`, `queryUsage`, `cleanupUsage`, `_setDbForTesting`
- Reuses `getDb()` from `rate-limit-tracker.ts` (now exported by Task 1.1)
- Schema is created by `getDb()` (Task 1.2) — no CREATE TABLE in this file, just INSERT/SELECT/DELETE
- All numeric fields default to 0 if undefined/null
- `recordUsage` is fire-and-forget — catch all errors, never throw
- `_setDbForTesting` re-exports from `rate-limit-tracker`
- Define `UsageRow` interface inline in this file
- **Reference:**
  - Plan artifact → "Task 1.2: Create extensions/usage-tracker.ts" section for exact code
  - `rate-limit-tracker.ts:28-55` for the singleton pattern
  - `rate-limit-tracker.test.ts` for test patterns
- **Anti-pattern:** Do NOT create a second `DatabaseSync` connection. Do NOT create the table in this file. Do NOT import pi SDK modules.
- **Acceptance:** Roundtrip test (record → query → verify) passes with `:memory:` database.

**Task 1.5: Create usage-tracker.test.ts**

Tags: `batch-1`, `ready-for-agent`
Body:
- File: `extensions/usage-tracker.test.ts` (NEW)
- Unit tests using `:memory:` SQLite injected via `_setDbForTesting`
- Each test: `beforeEach` creates fresh `:memory:` DB + creates tables, `afterEach` resets
- Tests:
  1. `recordUsage` + `queryUsage` roundtrip — insert one row, query returns it with correct fields
  2. `queryUsage` with routerRef filter — returns only matching rows
  3. `queryUsage` with since filter — returns only newer rows
  4. `queryUsage` with both filters — combined filter works
  5. `cleanupUsage` deletes old records but keeps new ones
  6. `cleanupUsage` returns correct count of deleted rows
  7. `recordUsage` with missing/undefined fields — defaults to 0
  8. `recordUsage` with zero usage — inserts successfully
  9. Multiple records — query returns all in reverse chronological order
  10. Empty database — `queryUsage` returns empty array
- **Reference:**
  - `rate-limit-tracker.test.ts:7-25` for `beforeEach`/`afterEach` pattern
  - `rate-limit-tracker.test.ts:84-95` for `_setDbForTesting` pattern
  - Plan artifact for usage schema and function signatures
- **Anti-pattern:** Do NOT use file-based database. Every test must use `:memory:`.
- **Acceptance:** `npx vitest run extensions/usage-tracker.test.ts` passes all tests.

### Batch 2 Tasks (Sequential, `ready-for-agent`)

**Task 2.1: Capture usage at 3 explicit points in provider.ts (no try-finally)**

Tags: `batch-2`, `ready-for-agent`
Body:
- File: `extensions/provider.ts`
- Import `recordUsage` from `./usage-tracker`
- **Capture point 1 — Success** (tryModel, `event.type === 'done'`, `!erredAfterContent`):
  ```ts
  try {
    const finalMsg = await delegatedStream.result();
    if (finalMsg?.usage) {
      recordUsage(output.model, ref, finalMsg.usage);
    }
  } catch { /* usage unavailable, skip */ }
  ```
  - Place BEFORE `resetCooldown(ref)` and `stream.end()`
  - `output.model` is the logical router name (e.g. `"orc"`), `ref` is provider/model ref
  - Do NOT set `output.usage` — footer gets usage from delegated stream events automatically
- **Capture point 2 — Error-after-content** (tryModel, `event.type === 'done'`, `erredAfterContent === true`):
  ```ts
  try {
    const finalMsg = await delegatedStream.result();
    if (finalMsg?.usage) {
      recordUsage(output.model, ref, finalMsg.usage);
    }
  } catch { /* usage unavailable, skip */ }
  ```
  - Place BEFORE `stream.end()` and `return false`
  - Do NOT set `output.usage` — same rationale as above
- **Capture point 3 — Error-before-content** (tryModel, `event.type === 'error' && !contentReceived`):
  - Place BEFORE the `throw`, in the existing error event handler inside the while loop:
  ```ts
  try {
    const finalMsg = await delegatedStream.result();
    if (finalMsg?.usage) {
      recordUsage(output.model, ref, finalMsg.usage);
    }
  } catch { /* usage unavailable, skip */ }
  ```
  - Do NOT add try-finally — it would create duplicate rows alongside the done event handler
  - Auth failures and stream-not-created cases produce no usage and don't need capturing
- **Reference:**
  - Plan artifact → "Task 2.1" section for exact code and capture point table
  - `provider.ts:139` for error-before-content handler (line ~139)
  - `provider.ts:220-228` for done-event handler
  - `review.md` → "Appendix A" for footer mechanism SDK analysis
- **Anti-patterns:** Do NOT use try-finally. Do NOT set `output.usage`. Do NOT block the request on usage capture (try-catch everything). Do NOT import `output.usage` into any test.
- **RED-GREEN gate:** Unit test in `usage-tracker.test.ts` verifies `recordUsage` inserts correctly. Integration test in `provider.test.ts` can verify that after `streamSimple()` completes, `queryUsage()` returns a row with the expected model ref (deferred to HITL).

### Batch 3 Tasks (Sequential, `ready-for-agent`)

**Task 3.1: Add /router cost and /router cleanup commands**

Tags: `batch-3`, `ready-for-agent`
Body:
- File: `extensions/commands.ts`
- Import `queryUsage`, `cleanupUsage` from `./usage-tracker`
- Import `UsageRow` type from `./usage-tracker`
- Import `USAGE_TABLE_NAME`, `CLEANUP_INTERVALS` from `./constants`
- Add `cost` subcommand handler:
  - Parse arguments: optional router_name, `--since=24h` flag
  - Default `--since`: all (no time filter)
  - Call `queryUsage({ routerRef, since })` 
  - Format table with columns: model, input tokens, output tokens, total tokens, cost, timestamp
  - Show aggregated totals at bottom
  - Group by router name when no specific router requested
- Add `cleanup` subcommand handler:
  - Parse interval argument: 24h, 1w, 1m, 2m, all
  - Call `cleanupUsage(before)` with computed timestamp
  - Display deleted row count
- Update `SUBCOMMANDS` array to include `cost` and `cleanup`
- Add autocomplete entries for both commands in `getArgumentCompletions`
- **Reference:**
  - Plan artifact → "Task 3.1" and "Task 3.2" sections for exact code
  - `commands.ts:155-170` for subcommand parsing pattern
  - `commands.ts:268+` for autocomplete pattern
  - `docs/prd-cost-usage.md` → "Commands" section for expected output format
- **Anti-pattern:** Do NOT add external table library. Use simple string padding. Do NOT modify the interactive menu. Do NOT make the command block (no async awaits for querying, but queries are sync so it's fine).
- **Acceptance:** Run `/router cost` in pi terminal → formatted table appears. Run `/router cleanup 24h` → deletion count appears.

### Batch 4 Tasks (HITL, `ready-for-human`)

**Task 4.1: Manual sign-off in pi**

Tags: `batch-4`, `ready-for-human`
Body:
- Steps:
  1. `npm test` — all tests pass
  2. Build/install extension in pi
  3. Configure a router model (e.g., `orc` with `["openai/gpt-4"]`)
  4. Send a message: verify footer shows real cost `$X.XXX`
  5. Run `/router cost` — verify usage row appears with correct model, tokens, cost
  6. Run `/router cost orc` — verify filtered
  7. Run `/router cost --since=24h` — verify time filter
  8. Run `/router cleanup 24h` — verify deletion count > 0
  9. Run `/router cost` — verify old records gone, recent ones remain
  10. Run `/router help` — verify `cost` and `cleanup` appear in help

---

## Verification Plan

### Per-Batch Verification

| Batch | Verification Method | Command |
|-------|-------------------|---------|
| 1 (Task 1.1) | Export exists | `grep 'export function getDb' extensions/rate-limit-tracker.ts` |
| 1 (Task 1.2) | Table created | SQLite inspect `model-router.db` after first call |
| 1 (Task 1.3) | Constants available | `npm test` passes |
| 1 (Task 1.4) | Module works | `npx vitest run extensions/usage-tracker.test.ts` |
| 1 (Task 1.5) | All tests pass | `npx vitest run extensions/usage-tracker.test.ts` |
| 2 (Task 2.1) | Usage captured | Integration test via provider.test.ts (deferred) or manual |
| 3 (Task 3.1) | Commands work | Manual in pi |
| 4 (Task 4.1) | Full sign-off | Manual in pi |

### Regression Guard

- `getDb()` export does not change behavior of existing functions — all existing tests must pass
- `provider.ts` capture points are wrapped in try-catch — cannot break existing flow
- `commands.ts` new subcommands don't affect existing ones
- `constants.ts` new exports don't collide with existing names
- `npm test` must pass after all batches complete

### Edge Cases

| Case | Expected | Test |
|------|----------|------|
| `delegatedStream.result()` throws | Skip silently, continue | Try-catch in capture |
| Usage object has undefined fields | Default to 0 | `toNum()` helper |
| Empty database, `/router cost` | "No usage records found." | Empty array check |
| Invalid cleanup interval | Show usage message | Validation in handler |
| Multiple router models | `/router cost` shows grouped by router | Group logic in handler |
| `--since=all` | No time filter | `since: undefined` → `queryUsage({})` |

### Closeout (DOX pass)

After all batches:
1. Check changed paths against DOX chain: `AGENTS.md` root + `extensions/` scope
2. Update nearest owning docs if any contract changed
3. Verify all test files exist and pass
4. Report any docs intentionally left unchanged and why

---

## Halt for Approval

Before implementation begins, review this plan and confirm:

1. **Batch ordering**: Batch 1 parallel (export, module, table, constants), Batch 2 sequential (capture), Batch 3 sequential (commands), Batch 4 HITL (sign-off)
2. **Key decisions**: Reuse `getDb()` singleton, table creation in `getDb()`, `output.model` as router name, 3 explicit capture points (no try-finally), footer flows through delegated stream events (no `output.usage` assignment)
3. **Schema**: usage table with 10 data columns + autoincrement id + 2 indexes
4. **Test strategy**: `:memory:` SQLite per test for isolation, `usage-tracker.test.ts` for unit, manual for integration

Review and approve to proceed with implementation.
