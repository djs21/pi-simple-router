# PRD: Cost & Usage Tracking

## Problem Statement

The router extension delegates requests to real provider models (OpenAI, Anthropic, etc.) but has **no visibility into the cost or token usage** of those delegations. Users have three blind spots:

1. **No per-request cost data** — Each delegation to a provider model incurs a real cost (input tokens × input rate + output tokens × output rate). The router currently discards the `usage` object from `delegatedStream.result().usage` after the delegation completes. Users have no idea what each request costs.

2. **No historical tracking** — There is no record of which models were used, how many tokens they consumed, and what they cost over time. Users cannot review usage patterns, identify expensive models, or track monthly spending.

3. **No cleanup mechanism** — If historical tracking is added, accumulated data needs a way to be pruned. Users should be able to delete old records on demand.

## Solution

**Capture `delegatedStream.result().usage` from every successful and failed delegation**, persist it to a new `usage` table in the existing SQLite database (`model-router.db`), and expose two new commands: `/router cost` for historical review and `/router cleanup` for data pruning.

The footer cost display is handled automatically by pi — copying the `usage` from the delegated stream's result into the router's `output.usage` before `stream.end()` causes pi's built-in footer cost accumulation (`$X.XXX`) to reflect the active model's actual cost.

## User Stories

**P0 — Core capture and display**

1. As a pi user, I want the footer to show the **actual cost of the active fallback model** (copied from the delegated stream's `result().usage`), so that I see real-time cost for each response, not the router model's zeroed-out cost.

2. As a pi user, I want **every successful API call** to record its token usage and cost in a local database, so that I can review my historical usage.

**P1 — Failure capture and commands**

3. As a pi user whose model errors after streaming partial content (error-after-content), I want the **partial usage** from that stream to be captured and stored in the database, so that failed requests are still accounted for.

4. As a pi user whose model errors before any content is sent (error-before-content), I want the **error's usage** (if the provider reports any) to be captured and stored, so that even failed pre-content calls are recorded.

5. As a pi user, I want to run `/router cost` to see **aggregated usage across all router models** (total tokens, total cost), sorted by model or recency, so that I can monitor my spending.

6. As a pi user, I want to run `/router cost [router_name]` to see usage **filtered to a specific router model** (e.g. `/router cost thinker`), so that I can isolate spending per logical model group.

7. As a pi user who has accumulated weeks of usage data, I want to run `/router cleanup 24h|1w|1m|2m|all` to **delete records older than a given threshold**, so that I can control database size and privacy.

**P2 — Display quality**

8. As a pi user, I want `/router cost` output to show a **table with columns**: router name, model ref, input tokens, output tokens, total tokens, total cost, and timestamp — formatted cleanly, so that the data is scannable.

9. As a pi user, I want `/router cost` to show **aggregated totals at the bottom** (total tokens, total cost across all displayed rows), so that I don't have to mentally sum.

10. As a pi user who rarely cares about costs, I want the cost tracking to have **zero performance impact when not requested** — capturing usage is a simple object copy + INSERT, no blocking IO that slows down responses.

## Implementation Decisions

### Data Source

- `delegatedStream.result().usage` from `@earendil-works/pi-ai` — this is the real usage object returned by the provider after a stream completes (successfully or with error-after-content). After `stream.end()` on the delegated stream, call `delegatedStream.result()` to get the final `AssistantMessage` with its `usage` field.

### SQLite Schema (new table in existing `model-router.db`)

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

### Module: New `extensions/usage-tracker.ts`

A self-contained module following the same SQLite singleton pattern as `rate-limit-tracker.ts`:

- Lazy-init database connection (reuses `getDb()` from `rate-limit-tracker.ts` or creates its own). **Decision**: share the same `DatabaseSync` instance via a shared connection helper, so both modules use one connection to `model-router.db`. This avoids file-lock contention between two connections to the same database.

- Export functions:
  - `recordUsage(routerRef: string, modelRef: string, usage: AssistantMessage['usage'], timestamp?: number): void` — INSERT a row into `usage`. Uses the existing `getDb()` singleton.
  - `queryUsage(opts: { routerRef?: string; since?: number }): UsageRow[]` — SELECT from `usage` with optional filters.
  - `cleanupUsage(before: number): number` — DELETE rows with timestamp older than `before`, returns count of deleted rows.
  - `_setDbForTesting(db?: DatabaseSync | null): void` — testing seam (same pattern as rate-limit-tracker).

- The module does NOT create its own `DatabaseSync` — it imports `getDb` from rate-limit-tracker (or a shared db module) to reuse the same connection.

**Ponytail consideration**: Reusing the existing `getDb()` avoids a second SQLite connection and the complexity of coordinating two connections to the same WAL-mode database. The shared connection pattern is already established and correct.

### Capture Points in `provider.ts`

Three capture points, all in `extensions/provider.ts`:

**1. Success (`tryModel`, `event.type === 'done'`)**
- Before `stream.end()`, capture `delegatedStream.result().usage` and copy it to `output.usage`.
- Also call `recordUsage(customName, ref, usage)` to persist.
- This is the primary capture path — every successful delegation logs usage.

**2. Error-after-content (`tryModel`, error event after content)**
- After `markRateLimited` and before `stream.end()`, capture `delegatedStream.result().usage` (which may be partial — some providers report usage even on partial failures).
- Copy to `output.usage`.
- Call `recordUsage(customName, ref, usage)`.

**3. Error-before-content (`routeStream` catch block)**
- After `markRateLimited`, attempt to capture `delegatedStream.result().usage` if available. Some providers report usage even on pre-content errors (e.g., rate limit headers with usage info).
- If usage exists, call `recordUsage(customName, ref, usage)`.
- `output.usage` is NOT updated here — no content was produced, so footer should not show cost for a failed request that produced no output.

### Footer Cost Display

When a model succeeds (or errors after content), `output.usage` is populated with the delegated stream's actual usage. Since `stream.end()` sends the final `AssistantMessage` with `usage` to pi's internals, pi automatically accumulates this into the footer display (`$X.XXX`).

**No custom footer code needed** — this is the same mechanism pi uses for non-router models. The router was previously zeroing out costs because `output.usage` was always `{ input: 0, output: 0, ... }`. Copying the real usage fixes the display automatically.

### Commands

**`/router cost [router_name] [--since 24h|1w|1m|2m|all]`**

- If `router_name` is provided, filter to that logical router model only.
- `--since` flag with optional value. Default: `all`.
- Output: formatted table with columns: router name, model ref, input tokens, output tokens, total tokens, total cost, timestamp.
- Bottom row: aggregated totals (total_tokens, cost_total).

Example output:
```
📊 Usage for "orc":
  Model                  Input    Output   Total    Cost
  openai/gpt-4           1,234    567      1,801    $0.089
  anthropic/claude-3     890      234      1,124    $0.052
  ──────────────────────────────────────────────────────
  Total                  2,124    801      2,925    $0.141
```

If no `router_name` and no `--since`, show all records, grouped by router name.

**`/router cleanup 24h|1w|1m|2m|all`**

- `24h` — delete records older than 24 hours
- `1w` — delete records older than 1 week
- `2m` — delete records older than 2 months
- `all` — delete all records

### Shared Database Connection

The `usage-tracker.ts` module reuses the `getDb()` and `_setDbForTesting()` exported by `rate-limit-tracker.ts`. This means:

- Single `DatabaseSync` connection to `model-router.db` for both cooldowns and usage
- WAL mode + 5s busy timeout handles concurrent access the same way
- Tests can inject a `:memory:` database that serves both tables via the same seam

**Ponytail**: No new database module. No second connection. Reuse the established `getDb()` singleton. If the two modules' concerns ever need separate databases, extract then — not before.

### Error Handling for Usage Capture

- `delegatedStream.result()` may throw if the stream was aborted or errored before producing a result. Wrap in try-catch — if usage is unavailable, skip recording silently. Non-blocking.
- `recordUsage` is fire-and-forget. If the INSERT fails (disk full, permissions), log a warning and continue. The router should never fail a request because usage tracking failed.
- The `usage` object fields may be `undefined` or `null`. Default to `0` for all numeric fields before INSERT.

### New Constants (in `constants.ts`)

```typescript
export const CLEANUP_INTERVALS: Record<string, number | null> = {
  '24h': 86_400_000,
  '1w': 604_800_000,
  '1m': 2_592_000_000,   // 30 days
  '2m': 5_184_000_000,   // 60 days
  'all': null,             // no time filter
} as const;

export const USAGE_TABLE_NAME = 'usage';
```

## Testing Decisions

### Seam: Unit via `usage-tracker.test.ts` (new file)

- `:memory:` SQLite database injected via `_setDbForTesting`
- Test `recordUsage` + `queryUsage` roundtrip
- Test `cleanupUsage` deletes old records but keeps new ones
- Test edge cases: empty usage (zeros), missing fields, high-cardinality data (many records)

### Seam: Integration via `provider.test.ts`

- Mock `streamSimple` to produce a delegating stream that, when `.result()` is called, returns an `AssistantMessage` with known usage
- Verify that after `streamSimple` completes, `getActiveRateLimits()` shows cooldown (error path) AND that `queryUsage` returns the recorded usage row
- Two sequential calls: first produces usage, second verifies cumulative behavior

### Test Doubles

- `delegatedStream.result()` returns a controlled `AssistantMessage` with a `usage` object — no real API calls
- `DatabaseSync`: use `:memory:` via `_setDbForTesting` for hermetic tests
- Test cleanup: `beforeEach` creates a fresh `:memory:` database, `afterEach` clears it

### Prior Art

- `rate-limit-tracker.test.ts` patterns: `_setDbForTesting`, synchronous SQLite operations, module-level singleton testing
- `provider.test.ts` patterns: mocked `streamSimple`, `delegatedStream` helper, async event stream iteration

## Out of Scope

- **Cost calculation from token counts**: The `cost` fields (`cost_input`, `cost_output`, `cost_total`) come from the provider's `usage` object, which already includes pricing. No client-side cost calculation.
- **Per-model pricing configuration**: Users cannot configure custom pricing. We use whatever the provider reports in `usage.cost`.
- **Export to CSV/JSON**: Historical data is viewable only via `/router cost`. File export is future work.
- **TUI integration**: No changes to TUI components. The footer cost display is handled by pi's existing mechanism via `output.usage`.
- **Cost alerts / budgets**: No notifications when spending exceeds a threshold. Pure tracking.
- **Deduplication**: If the same request spawns multiple delegations (retries), usage rows may duplicate. Users should be aware that each `recordUsage` call creates one row, and cleanup is manual.
- **Multi-user isolation**: The database is per-machine (`~/.local/share/pi/model-router.db`). No user-scoped partitioning.

## Further Notes

- The `usage` object from `delegatedStream.result()` has the shape: `{ input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number, cost: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number } }`. The schema's `cost_input`, `cost_output`, `cost_total` fields map from `usage.cost.input`, `usage.cost.output`, `usage.cost.total`.
- The `total_tokens` column in the schema is `usage.totalTokens` from the usage object.
- Timestamps are stored in unix milliseconds (`Date.now()`) for consistency with the cooldowns table.
- The `CLEANUP_INTERVALS` constants define convenient named durations. The `--since` flag value is case-insensitive.
- This PRD requires implementing the shared `getDb()` pattern change (making `getDb` importable from `rate-limit-tracker.ts` rather than module-private). The `_setDbForTesting` is already exported, but `getDb` is currently module-private. **Implementation must export `getDb`** (or create a shared db module) so `usage-tracker.ts` can reuse it.
- The `sqlite` usage table will grow unboundedly without cleanup. Users should be educated (via `/router help` output) about the `/router cleanup` command.
