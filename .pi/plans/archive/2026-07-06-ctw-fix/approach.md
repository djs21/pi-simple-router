# Approach: Dynamic Context Window Update

**Date:** 2026-07-06
**Related:** PRD `docs/prd-ctw-dynamic-update.md`
**Beads:** `pi-model-router-d1h`, `pi-model-router-67b`, `pi-model-router-ua2`, `pi-model-router-b0d`

---

## 1. Problem Recap

Pi's footer reads `ctx.model.contextWindow` (AgentSession line 2415). The router model's `contextWindow` is set at registration time from the **maximum** across all fallback models (`buildModels` in `provider.ts:77`). The active fallback model may have a smaller CTW, causing:

- Wrong auto-compaction threshold
- Potential overflow before compaction
- Misleading footer display

**Root cause:** `buildModels()` takes the `max` across all refs. The footer always shows this max, never the active model's actual CTW.

---

## 2. Solution: `syncContextWindow` Helper

One exported function in `extensions/provider.ts`. Directly mutates `model.contextWindow` — a plain JS property on the model object (same ref as `agent.state.model`) that propagates immediately to the footer.

### Signature & Behavior

```typescript
/**
 * Sync model.contextWindow to the resolved model's contextWindow.
 * Direct mutation — propagates immediately to pi's footer display.
 * No-op if model is null or ref can't be resolved.
 */
export const syncContextWindow = (
  model: { contextWindow: number } | null,
  ref: string,
  registry: ModelRegistry,
): void => {
  if (!model) return;
  const resolved = resolveModelRef(ref, registry);
  if (!resolved) return;
  const targetModel = findModel(registry, resolved.provider, resolved.modelId);
  if (!targetModel) return;
  model.contextWindow = targetModel.contextWindow;
};
```

**Why `model` parameter instead of `Context`?** Because the same function is called from:
- `routeStream` (where `model` is the first parameter — `Model<Api>`, same ref as `agent.state.model`)
- `model_select` handler (where `ctx.model` is `ExtensionContext.model`, also the same ref)

Direct mutation on `model.contextWindow` is O(1) and propagates immediately to pi's footer. No cast needed — the function takes a duck-typed `{ contextWindow: number }` directly.

**Uses existing helpers:**
- `resolveModelRef(ref, registry)` — from `./config` (already imported in `provider.ts`)
- `findModel(registry, provider, modelId)` — local helper in `provider.ts` (handles OpenRouter upstream-prefixed IDs)

**Must be exported** for use in `extensions/index.ts` (model_select handler).

---

## 3. Call Sites

### 3a. `routeStream` catch block — error BEFORE content

**Location:** `extensions/provider.ts` inside `routeStream`'s async IIFE, the `catch (err)` block at the start of the fallback loop.

**Current logic:**
```
for each candidate ref:
  try { succeeded = await tryModel(...) }
  catch (err) {
    lastError = ...
    if (!isAbort) {
      markRateLimited(ref, ...)
      markRateLimited(provider, ...) if provider-level error
    }
    if (!isLast) {
      pushTextBlock("...gagal, fallback ke next")
    }
  }
```

**Change:** After `markRateLimited`, insert CTW sync:

```typescript
if (!isAbort) {
  markRateLimited(ref, config.rateLimitCooldownMs, errType);
  if (isProviderLevelError(lastError)) {
    markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
  }

  // NEW: sync CTW to the next candidate (or current ref if last)
  const syncRef = isLast ? ref : candidates[i + 1];
  syncContextWindow(model, syncRef, registry);
}
```

**What CTW gets set to:**
| Case | CTW |
|------|-----|
| Non-last model fails | next candidate (`candidates[i+1]`) |
| Last model fails | current (last attempted) ref |
| RouterAbortError (pi timeout) | no sync — request cancelled |

**When it propagates:** Immediately after sync. The footer re-renders on next idle/paint cycle. For the current turn's remaining execution, the model already running uses the old stream. On the **next turn**, `turn_start` or `model_select` will call `updateRouterChainStatus` (existing) and optionally re-sync (new in 3c).

**Cooldowned next candidate edge case:** If the next candidate is cooldowned, the CTW is still synced to its value. The loop will skip it and try the following one. CTW will be wrong for the rest of this turn, but corrected on next `turn_start`/`model_select`. Acceptable transient — the alternative (walk candidates to find non-cooldowned) adds complexity for minimal accuracy gain.

---

### 3b. `routeStream` after `tryModel` returns `false` — error AFTER content

**Location:** `extensions/provider.ts` inside `routeStream`'s async IIFE, after `const succeeded = await tryModel(...); if (succeeded) return;`

**Current logic:**
```typescript
try {
  const succeeded = await tryModel(/*...*/);
  if (succeeded) return;  // happy path
  // (fall-through to next candidate — fall-through only happens on error-after-content)
} catch (err) {
  // error-before-content handled here
}
```

**Change:** After `if (succeeded) return;`, insert CTW sync:

```typescript
try {
  const succeeded = await tryModel(ref, targetModel, ctx, options, reasoningOption,
    stream, output, config, registry,
    i, candidates.length, elapsedStart);
  if (succeeded) return;

  // NEW: error-after-content — tryModel returned false
  // markRateLimited already called inside tryModel for this case
  // Sync CTW to next candidate (or current ref if last)
  const syncRef = isLast ? ref : candidates[i + 1];
  syncContextWindow(model, syncRef, registry);
} catch (err) {
  // error-before-content — sync handled in catch block (3a)
  ...
}
```

**Why separate from the catch block?** `tryModel` does NOT throw for error-after-content. It returns `false` after ending the stream internally. The sync must happen on this return path too.

**Interaction with catch block:** When `tryModel` returns false, the catch block does NOT fire. When it throws (error-before-content), the catch block fires. So both paths need explicit sync. No double-sync risk.

**Known existing issue:** When tryModel returns false (error-after-content), the outer stream is already ended. The loop continues to the next candidate, but its events go nowhere. This is a pre-existing bug (not introduced by this change). The CTW sync is still correct — it affects the **next turn**, not the current turn's stream.

---

### 3c. `model_select` handler

**Location:** `extensions/index.ts`

**Current logic:**
```typescript
api.on('model_select', (_event: unknown, ctx: ExtensionContext) => {
  updateRouterChainStatus(ctx);
});
```

**Change:** After `updateRouterChainStatus`, sync CTW to the first non-cooldowned model:

```typescript
api.on('model_select', (_event: unknown, ctx: ExtensionContext) => {
  updateRouterChainStatus(ctx);
  syncContextWindowForSelectedModel(ctx);
});
```

Where `syncContextWindowForSelectedModel` is defined in `index.ts`:

```typescript
function syncContextWindowForSelectedModel(ctx: ExtensionContext): void {
  const model = ctx.model;
  if (model?.provider !== PROVIDER_NAME) return;  // not a router model
  const cfg = currentConfig.models[model.id];
  if (!cfg) return;
  const activeRef = cfg.models.find((ref) => !isRateLimited(ref));
  if (!activeRef || !modelRegistry) return;
  syncContextWindow(model, activeRef, modelRegistry);
}
```

**`syncContextWindow` import** — add to the existing import line in `index.ts`:

```typescript
import { registerRouterProvider, syncContextWindow } from './provider.js';
```

**When this fires:**
- User selects the router model directly
- On session startup (pi selects the last-used model, which may be the router)
- After `loadAndRegister` in `session_start` (model is already selected at that point, but `model_select` doesn't re-fire — only on actual selection)

**Coverage note:** On `session_start`, `updateRouterChainStatus` is called explicitly (line in `session_start` handler). The CTW should be synced here too, not just in `model_select`. Add a call to `syncContextWindowForSelectedModel` in `session_start` after `updateRouterChainStatus`:

```typescript
api.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
  if (!modelRegistry) {
    modelRegistry = (api as any).modelRegistry ?? (ctx as any).modelRegistry;
  }
  await loadAndRegister();
  setStatusLine(ctx, `🔀 Router: ${Object.keys(currentConfig.models).length} models`);
  updateRouterChainStatus(ctx);
  syncContextWindowForSelectedModel(ctx);  // NEW
});
```

---

## 4. What CTW Gets Set To — Summary Table

| Event | Call Site | CTW Source | Rationale |
|-------|-----------|------------|-----------|
| User selects router model | `model_select` | first non-cooldowned ref | The model that will handle the next request |
| Session starts with router | `session_start` | same as above | Same logic |
| Fallback: error before content, not last | `routeStream` catch block | `candidates[i+1]` | Next candidate will be tried this turn |
| Fallback: error before content, last | `routeStream` catch block | current `ref` (last attempted) | Better than max across all; only candidate left |
| Fallback: error after content, not last | `routeStream` after tryModel false | `candidates[i+1]` | Same as above — correct for next turn |
| Fallback: error after content, last | `routeStream` after tryModel false | current `ref` (last attempted) | Same reasoning |
| RouterAbortError (pi abort) | none | unchanged | Request cancelled, no meaningful CTW |

---

## 5. File Changes

### `extensions/provider.ts`

| Change | Detail |
|--------|--------|
| **Export `syncContextWindow`** | New exported function after `findModel` (~line 50). Uses `resolveModelRef` + `findModel`. |
| **routeStream catch block** | After `markRateLimited` (inside `if (!isAbort)`), call `syncContextWindow(model, isLast ? ref : candidates[i+1], registry)`. |
| **routeStream after tryModel false** | After `if (succeeded) return;`, call `syncContextWindow(model, isLast ? ref : candidates[i+1], registry)`. |

**Exact insertion points:**

1. **After `findModel`** (around line 50) — add `syncContextWindow` function.

2. **Catch block** (inside routeStream IIFE, around line 310-315) — inside `if (!isAbort)` after the two `markRateLimited` calls:

```typescript
  // inside: if (!isAbort) { ... }
  markRateLimited(ref, config.rateLimitCooldownMs, errType);
  if (isProviderLevelError(lastError)) {
    markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
  }
+ // Sync CTW to reflect the next model that will handle requests
+ const syncRef = isLast ? ref : candidates[i + 1];
+ syncContextWindow(model, syncRef, registry);
```

Note: `ctx` in the routeStream IIFE is named `context`. The sync uses the `model` parameter (first param of routeStream).

3. **After `tryModel` returns false** (around line 295-300) — after `if (succeeded) return;`:

```typescript
  const succeeded = await tryModel(
    ref, targetModel, context, options, reasoningOption,
    stream, output, config, registry,
    i, candidates.length, elapsedStart,
  );
  if (succeeded) return;
+ // Error-after-content: sync CTW to next candidate
+ const syncRef = isLast ? ref : candidates[i + 1];
+ syncContextWindow(model, syncRef, registry);
```

### `extensions/index.ts`

| Change | Detail |
|--------|--------|
| **Import `syncContextWindow`** | Add to import from `./provider.js`. |
| **`model_select` handler** | After `updateRouterChainStatus(ctx)`, call `syncContextWindowForSelectedModel(ctx)`. |
| **`session_start` handler** | After `updateRouterChainStatus(ctx)`, call `syncContextWindowForSelectedModel(ctx)`. |
| **Add helper function** | `syncContextWindowForSelectedModel(ctx)` — finds first non-cooldowned ref, calls `syncContextWindow`. |

---

## 6. Edge Cases

| Edge Case | Behavior | OK? |
|-----------|----------|-----|
| **Registry null** | routeStream returns error at start if registry is null (already guarded). model_select checks `modelRegistry` before calling sync. | ✅ |
| **model null** | `syncContextWindow` returns early (`if (!model) return`). | ✅ |
| **Ref not found in registry** | `resolveModelRef` returns null → early return. `findModel` returns null → early return. | ✅ |
| **All models cooldowned, user selects router** | `model_select`: `cfg.models.find((ref) => !isRateLimited(ref))` returns `undefined` → no sync. Last set CTW persists (was set by last routeStream call). | ✅ transient |
| **User selects non-router model** | `model_select`: `ctx.model?.provider !== PROVIDER_NAME` → early return. Pi handles CTW natively for direct models. | ✅ |
| **Next candidate is cooldowned** | CTW synced to cooldowned model's value. Loop will skip it. Wrong for this turn, corrected on next turn_start. | Acceptable |
| **OpenRouter prefixed model** | `resolveModelRef` + `findModel` handle this already (smart lookup with upstream prefix fallback). | ✅ |
| **First routeStream call** | CTW starts at max value (set by `buildModels` at registration). First fallback error syncs it to actual active model. | ✅ |
| **Multiple rapid fallbacks per turn** | CTW updates on each fallback. End state reflects the last model tried. | ✅ |

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pi changes `agent.state.model` internals | CTW sync breaks (footer shows wrong value) | Same risk as current approach; alternative (re-register + setModel) also depends on internals. No data corruption. Fix is one line. |
| `syncContextWindow` called during routeStream execution | CTW changes mid-request | Safe — only affects display properties. Router's actual fallback logic is unaffected. |
| `model_select` fires before registry available | `modelRegistry` is null → early return | Already guarded in `syncContextWindowForSelectedModel`. |
| tryModel returns false + catch block both fire | Double sync | Impossible — tryModel either returns false (no throw) OR throws (catch block). Never both. |

---

## 8. Backup: Opsi A (Re-register + setModel)

If Opsi C is rejected (or fails in review), fallback to:

1. Call `api.registerProvider(PROVIDER_NAME, { ... updated models with correct CTW })`  
2. Call `pi.setModel(updatedModel)` to switch `agent.state.model`

**Downsides:** Triggers `model_select` event with source "set" → user sees a "model changed" notification. System model entry changes. Unnecessary side effects for what Opsi C does silently.

**When to switch:** If code review identifies that direct mutation of `model.contextWindow` is unreliable (e.g., pi changes the property to a getter/setter or the model object gets replaced on session_start). Opsi C is preferred.

---

## 9. Files Summary

| File | Lines Changed | Change Type |
|------|---------------|-------------|
| `extensions/provider.ts` | ~10 new (function) + 6 insertions (2 call sites) | Add + edit |
| `extensions/index.ts` | ~15 new (helper + 2 call sites + 1 import) | Add + edit |

No new files. No schema/config changes. No new dependencies.
