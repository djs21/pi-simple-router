# Scout Report: Cost & Usage Tracking Foundation

## Project Structure

Single-module pi extension under `extensions/`. No monorepo, flat layout.

```
extensions/
  index.ts              — Entry point: wires provider, commands, hooks
  provider.ts           — Core fallback chain logic (streamSimple)
  rate-limit-tracker.ts — SQLite-backed cooldown tracker
  commands.ts           — /router subcommands (status, cd, reload, clearcache, help)
  config.ts             — Config loading/normalization, helpers
  constants.ts          — Numeric/token constants
  types.ts              — RouterConfig, CustomModelConfig, etc.
  model-selector.ts     — Interactive model picker widget
  ui.ts                 — Status line update helper
  provider.test.ts      — 32KB test file, comprehensive
  rate-limit-tracker.test.ts — SQLite :memory: tests
  config.test.ts        — Config normalization tests
```

---

## 1. `extensions/provider.ts`

### `tryModel` function signature (line ~139)

```ts
async function tryModel(
  ref: string,
  targetModel: Model<Api>,
  ctx: Context,
  options: SimpleStreamOptions | undefined,
  reasoningOption: Record<string, unknown>,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  config: RouterConfig,
  registry: ModelRegistry,
  refIdx: number,
  totalRefs: number,
  elapsedStart: number,
): Promise<boolean>
```

Returns `true` on success (stream ended normally), `false` on error-after-content fallback.

### `event.type === 'done'` handler (line ~220)

```ts
if (event.type === 'done') {
  if (erredAfterContent) {
    stream.end();
    return false;   // ← fallback to next model, cooldown already set
  }
  resetCooldown(ref);  // ← successful completion, clear cooldown
  stream.end();
  return true;
}
```

### Error-after-content handler (lines ~209–217)

```ts
if (event.type === 'error' && contentReceived && event.reason !== 'aborted') {
  const errType = classifyError(event.error?.errorMessage ?? 'Unknown');
  markRateLimited(ref, config.rateLimitCooldownMs, errType);
  erredAfterContent = true;
}
```

This marks rate-limited but does NOT return — it continues to the `done` event which then returns `false`.

### Catch block in `routeStream` — error-before-content (lines ~375–409)

```ts
if (!isAbort) {
  const errType = classifyError(lastError);
  markRateLimited(ref, config.rateLimitCooldownMs, errType);
  if (isProviderLevelError(lastError)) {
    markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
  }
  // Sync CTW to next candidate
  const syncRef = isLast ? ref : candidates[i + 1];
  syncContextWindow(model, syncRef, registry);
}
```

### `delegatedStream` variable (line ~170)

```ts
const delegatedStream = streamSimple(targetModel, ctx, {
  ...options,
  apiKey: auth.apiKey,
  headers: auth.headers,
  ...reasoningOption,
});
```

This is the **inner** stream from pi's actual streamSimple. The tryModel function iterates it manually with an abort-race pattern.

### `output` variable (line ~285 — in `routeStream`)

```ts
const output = createEmptyMessage(model);
```

The `createEmptyMessage` function creates the `AssistantMessage` skeleton at line ~80:

```ts
const createEmptyMessage = (model: Model<Api>): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
});
```

**Key detail for cost tracking:** `usage` is hardcoded to all zeros. There's no code in this codebase that populates real usage data. The cost tracking agent would need to extract this from the delegated stream's final event.

### `stream.end()` calls

There are **5** explicit `stream.end()` calls in `routeStream`'s async IIFE, plus 2 in tryModel:
1. Line ~228: `stream.end()` in the natural end case inside tryModel
2. Line ~239: `stream.end()` in the "stream ended without done event" fallthrough
3. Line ~276: `stream.end()` after unknown model error push
4. Line ~284: `stream.end()` after registry unavailable error
5. Line ~294: `stream.end()` after all candidates filtered error
6. Line ~304: `stream.end()` after pre-flight abort check
7. Line ~430: `stream.end()` after all fallbacks exhausted error push

---

## 2. `extensions/rate-limit-tracker.ts`

### `getDb()` pattern (line ~28)

```ts
let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (_db) return _db
  _db = new DatabaseSync(getDbPath())
  _db.exec('PRAGMA journal_mode=WAL')
  _db.exec('PRAGMA busy_timeout=5000')
  _db.exec(`CREATE TABLE IF NOT EXISTS cooldowns (... )`)
  return _db
}
```

Module-level singleton, lazy init. All public functions call `getDb()` internally.

### `_setDbForTesting` pattern (line ~55)

```ts
export function _setDbForTesting(db?: DatabaseSync | null): void {
  _db = db ?? null
}
```

Sets the module-level `_db` variable directly. Tests pass `new DatabaseSync(':memory:')` and manually create the table. Resetting to null makes the next getDb() call create a file-based connection.

### Import pattern

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
```

All Node.js built-ins. No SQLite query builders — raw SQL via `DatabaseSync` prepared statements.

### `CREATE TABLE IF NOT EXISTS` (line ~40)

```sql
CREATE TABLE IF NOT EXISTS cooldowns (
  model_ref     TEXT PRIMARY KEY,
  error_type    TEXT NOT NULL,
  expiry_at     INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  consecutive   INTEGER DEFAULT 1 CHECK(consecutive >= 1)
)
```

This is the **only** table. Schema is created lazily inside getDb().

---

## 3. `extensions/commands.ts`

### Command registration

Single `/router` command registered via `api.registerCommand('router', {...})`. Handler dispatches on first token.

### Subcommands

| Subcommand | Lines | Description |
|---|---|---|
| `status` | ~179–209 | Shows router models + cooldowns with escalation tiers |
| `reload` | ~211–224 | Reloads config, updates status |
| `cd` / `cooldown` | ~226–248 | Shows cooldowns only (alias `cooldown`) |
| `clearcache` | ~250–253 | Calls `clearRateLimits()` |
| `help` | ~255–260 | Lists subcommands |
| _(none)_ | ~262 | Falls through to `mainMenu()` interactive mode |

### Parser (line ~155)

```ts
const parts = args.trim().split(/\s+/).filter(Boolean)
const [subcmd] = parts
```

Simple whitespace split, first token as subcommand. No flags or options parsing at all for subcommands.

### Autocomplete (line ~268)

```ts
getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
  const trimmed = argumentPrefix.trimStart()
  const hasTrailingSpace = /\s$/.test(argumentPrefix)
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : []
  // ...
}
```

Returns `AutocompleteItem[]` with `{ value, label, description }`.

### Interactive menu (line ~82)

`mainMenu()` renders a TUI select menu with 5 options: Buat, Edit, Hapus, Lihat, Keluar. Uses `ctx.ui.select()` and `ctx.ui.input()`.

---

## 4. `extensions/constants.ts`

```ts
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384
export const CONFIG_FILENAME = 'model-router.json'
export const PROVIDER_NAME = 'router'
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000          // 5 min

export const ESCALATION_TIER_1_MAX = 4
export const ESCALATION_TIER_2_MIN = 5
export const ESCALATION_TIER_2_MAX = 6
export const ESCALATION_TIER_3_MIN = 7
export const ESCALATION_COOLDOWN_TIER_1_MS = 300_000           // 5 min
export const ESCALATION_COOLDOWN_TIER_2_MS = 3_600_000         // 1 hour
export const ESCALATION_COOLDOWN_TIER_3_MS = 21_600_000        // 6 hours
```

All numeric constants for cooldown escalation tiers.

---

## 5. `extensions/types.ts`

```ts
export interface RouterConfig {
  models: Record<string, CustomModelConfig>
  rateLimitCooldownMs?: number    // base cooldown in ms (default 300000)
}

export interface CustomModelConfig {
  models: string[]                // canonical refs like "openai/gpt-4"
  thinking?: ThinkingLevel | null
}

export interface RouterState {
  currentModel: string | null
}

export type SaveScope = 'global' | 'project'
```

---

## 6. Provider Test Patterns

### Mocks

- `@earendil-works/pi-ai/compat` → `streamSimple` is fully mocked via `vi.mock()`
- `@earendil-works/pi-ai` → `createAssistantMessageEventStream` is mocked to return a stream with a tracked `_endPromise` that tests `await` to know when the async IIFE completes
- The stream mock has `push: vi.fn()`, `end: vi.fn()`, and a fake async iterator

### Test setup

```ts
function setupRouter(config: RouterConfig, registry: any) {
  registerRouterProvider(mockApi, config, registry)
  const providerCfg = mockApi.registerProvider.mock.calls[0][1]
  return providerCfg  // has .streamSimple
}
```

Then call `providerCfg.streamSimple(model, ctx, {})` and `await (stream as any)._endPromise`.

### Stream helper functions

- **`successStream()`** — yields `text_delta` → `done`
- **`delegatedStream(event)`** — yields one event then ends (used for error-before-content)
- **`delegatedStreamWithContent(first, second)`** — yields two events then ends
- **`errorAfterContentStream(reason, errorMessage)`** — yields `text_delta` → `error` → `done`

### Cooldown assertions pattern

```ts
const limits = getActiveRateLimits()
expect(limits.length).toBe(1)
expect(limits[0].ref).toBe('openai/gpt-4')
expect(limits[0].remainingMs).toBeGreaterThan(0)
```

For escalation tests:
```ts
expect(limits[0].consecutive).toBe(5)
expect(limits[0].remainingMs).toBeGreaterThan(3_500_000)  // > 1h tier
```

### Key: no resetCooldown on failure

Tests verify that error-after-content does NOT call `resetCooldown` — the entry persists. On success, `resetCooldown` is called.

---

## Gotchas for Cost & Usage Tracking

1. **usage is always zero** — `createEmptyMessage` hardcodes `usage: { input: 0, output: 0, ... }`. Real usage data must be extracted from the `delegatedStream` events (the inner `streamSimple` return). The `done` event from the delegated stream likely contains usage — it's currently discarded.

2. **No cost tracking infrastructure exists** — no per-model cost table, no usage aggregation, no token counting.

3. **Rate limit cooldown is tracked in SQLite but cost is not** — the `cooldowns` table is the only persistent table. Cost tracking would need a new table or a new data store.

4. **`delegatedStream` is iterated manually** — tryModel doesn't use `for await...of`, it uses a manual iterator with abort racing. Any cost extraction from stream events must fit into this pattern.

5. **Abort signal racing** — `Promise.race` between `next()` and an abort listener. Cost extraction code must not interfere with this race.

6. **Config doesn't carry cost-per-token data** — `RouterConfig` has no cost fields. Model costs in `buildModels()` are hardcoded to 0. Real cost tracking needs the underlying model registry's cost data (which already has `cost: { input, output, cacheRead, cacheWrite }` in each model).

7. **Provider-level vs model-level cooldown** — uses `__provider:<name>` prefix for provider-wide errors. Cost tracking would need similar provider-aware aggregation.

8. **`model-selector.ts` exists** — interactive picker for model selection in commands. Not relevant for cost tracking but exists as a module.
