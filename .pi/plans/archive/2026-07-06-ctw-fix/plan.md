# Plan: Dynamic Context Window Update

**Date:** 2026-07-06
**Status:** Draft
**Directory:** `/home/djs/project/pi-model-router`
**Source PRD:** `docs/prd-ctw-dynamic-update.md`
**Approach review:** `.pi/plans/2026-07-06-ctw-fix/approach.md`
**Code review:** `.pi/plans/2026-07-06-ctw-fix/review.md`
**Issues:** `pi-model-router-d1h` (Slice 1), `pi-model-router-67b` (Slice 2), `pi-model-router-ua2` (Slice 3), `pi-model-router-b0d` (Slice 4)

---

## Context / Problem Statement

`buildModels()` in `provider.ts:77` computes `contextWindow` as the **max** across all fallback refs. Pi's footer reads `agent.state.model.contextWindow` — so the footer always shows the max CTW, never the active model's actual CTW.

This causes:
1. **Wrong auto-compaction threshold** — pi compacts based on router model's CTW (max). Active model with smaller CTW may overflow before compaction triggers.
2. **Wrong maxTokens** — pi's maxTokens uses the router model's CTW. API request may exceed real limit and get rejected (413).
3. **Misleading footer** — shows max across all fallbacks, not the active model's capacity.

**Root cause:** `buildModels()` takes `Math.max()` across all refs. No mechanism updates `model.contextWindow` when active model changes.

**Approach (reviewed & ACC'd):** Direct mutation `model.contextWindow = X` via a `syncContextWindow(model, ref, registry)` helper. O(1), no side effects, propagates immediately to footer.

---

## Goal (Definition of Done)

All four slices implemented and verified:

### Slice 1 — CTW update in `routeStream` catch block
- [ ] `syncContextWindow()` helper function exported from `provider.ts`
- [ ] Called in `routeStream` catch block after `markRateLimited`, before fallback notification text
- [ ] CTW set to `candidates[i+1]` (next candidate) when not last; `ref` (current) when last

### Slice 2 — CTW update in `tryModel` error-after-content
- [ ] `syncContextWindow()` called after `tryModel` returns `false` (error-after-content path)
- [ ] CTW set to `candidates[i+1]` when not last; `ref` when last

### Slice 3 — CTW update in `model_select` + `session_start` handlers
- [ ] `syncContextWindow()` imported in `index.ts`
- [ ] New helper `syncContextWindowForSelectedModel(ctx)` in `index.ts`
- [ ] Called from `model_select` handler after `updateRouterChainStatus(ctx)`
- [ ] Called from `session_start` handler after `updateRouterChainStatus(ctx)`
- [ ] CTW set to first non-cooldowned ref; no-op for non-router models or when no non-cooldowned ref

### Slice 4 — maxTokens sync + integration sign-off (HITL)
- [ ] `syncMaxTokens()` helper added (same pattern as `syncContextWindow`)
- [ ] Called at same call sites
- [ ] Manual verification that footer shows correct CTW + maxTokens after various fallback scenarios

---

## Key Findings (Prova Real)

**From approach review** (`.pi/plans/2026-07-06-ctw-fix/approach.md`):
1. `syncContextWindow(model, ref, registry)` — direct mutation, no `ctx.model` (P0.1 from review).
2. Parameter `model` is `Model<Api>` — same ref as `agent.state.model`. Direct mutation propagates to footer.
3. Uses existing helpers `resolveModelRef(ref, registry)` (from `./config`) and `findModel(registry, provider, modelId)` (local in `provider.ts`).
4. Three call sites: catch block (Slice 1), after tryModel false (Slice 2), model_select/session_start (Slice 3).
5. maxTokens sync deferred — same approach, separate helper.

**From code review** (`.pi/plans/2026-07-06-ctw-fix/review.md`):
1. ✅ P0.1 fixed — all call sites use `model` parameter directly, never `context.model`.
2. ✅ All variables accessible at insertion points (`model`, `ref`, `isLast`, `candidates`, `registry`, `i`).
3. ✅ `candidates[i+1]` OOB guarded by `!isLast`.
4. ✅ No double-sync risk — `tryModel` either returns `false` (no throw) OR throws (catch block).
5. ✅ Sync inside `if (!isAbort)` in catch — aborted requests skip sync.

**From codebase read** (`extensions/provider.ts`, `index.ts`):

Key line numbers in `provider.ts`:
- Line 66-82: `findModel()` function — insertion point after for `syncContextWindow` (line ~83)
- Line 279: `async function tryModel(...)` starts
- Line 376-378: error-after-content markRateLimited in tryModel (after content received)
- Line 584-589: `try { const succeeded = await tryModel(...); if (succeeded) return;`
- Line 590-630: `catch (err) { ... }` block
  - Line 597: `if (!isAbort) {` — insertion point for CTW sync after `markRateLimited`
  - Line 603: `markRateLimited(ref, config.rateLimitCooldownMs, errType);`
  - Line 605-606: provider-level `markRateLimited(...)`
  - Line 614-625: fallback notification text (`pushTextBlock`)
- Line 678: `export const registerRouterProvider`

Key line numbers in `index.ts`:
- Line 1-8: imports
- Line 48: `function updateRouterChainStatus(ctx)`
- Line 68-76: `session_start` handler
- Line 78-80: `model_select` handler
- Line 82-84: `turn_start` handler

---

## Authoritative Inputs

| Input | Source | Key Content |
|---|---|---|
| PRD | `docs/prd-ctw-dynamic-update.md` | Problem, solution, user stories, implementation decisions |
| Approach review | `.pi/plans/2026-07-06-ctw-fix/approach.md` | Signature, behavior, call sites, edge cases, backup plan |
| Code review | `.pi/plans/2026-07-06-ctw-fix/review.md` | P0.1 fix verified, scope analysis, P1-P2 notes |
| Codebase | `extensions/provider.ts` | findModel (L66-82), routeStream catch block (L590-630), tryModel (L279-395) |
| Codebase | `extensions/index.ts` | Import block (L1-8), handlers (L68-84) |
| Codebase | `extensions/provider.test.ts` | Mock patterns (delegatedStream, successStream, setupRouter) |

---

## Changes (Steps)

### Batch 1 (parallel — no deps): Task 1.1 + Task 1.3

#### Task 1.1: Add `syncContextWindow()` helper in provider.ts + call in catch block (Slice 3 + Slice 1)

**Tipe:** AFK
**Issue:** `pi-model-router-ua2` (Slice 3: model_select handler — no blocker) + `pi-model-router-d1h` (Slice 1: catch block — no blocker)
**Batch:** 1
**Blocker:** none
**RED-GREEN Gate:** Test that verifies `syncContextWindow` is exported and callable, plus test that catch block syncs CTW to next candidate on error-before-content.

##### Files Changed

**`extensions/provider.ts`**

1. **Add `syncContextWindow` function** — insertion after `findModel` (line ~82, after `};` that closes `findModel`, before `/** Check whether... */` for `modelSupportsImage`).

   Exact insertion point (line ~82-83):
   ```
   82:   return null;
   83: };
   84:
   85: /** Check whether the model referenced by a canonical ref supports image input. */
   ```

   Insert after `};` (line 83), before the empty line (line 84):

   ```typescript
   };

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

   /** Check whether the model referenced by a canonical ref supports image input. */
   ```

2. **Insert CTW sync in catch block** — after the two `markRateLimited` calls, before `if (!isLast)` fallback notification.

   Exact insertion point (inside `if (!isAbort)` block, line ~606-607):

   ```
   603:         markRateLimited(ref, config.rateLimitCooldownMs, errType);
   604:         // Cooldown provider-level untuk infra errors (502, 503, 504, dll)
   605:         if (isProviderLevelError(lastError)) {
   606:           markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
   607:         }
   608:       }
   609:
   610:       if (!isLast) {
   ```

   Insert after the closing `}` of provider-level cooldown (line 607), before `}` that closes `if (!isAbort)` (line 608):

   ```typescript
         // Cooldown provider-level untuk infra errors (502, 503, 504, dll)
         if (isProviderLevelError(lastError)) {
           markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
         }
         // Sync CTW to reflect the next model that will handle requests
         const syncRef = isLast ? ref : candidates[i + 1];
         syncContextWindow(model, syncRef, registry);
       }
   ```

##### Verification
```bash
npx vitest run extensions/provider.test.ts
npx vitest run -t "syncContextWindow"  # after adding test
```

##### Scope Guard
- Do NOT change `isLast`, `candidates`, or any loop logic
- Do NOT touch `tryModel` function body — that's Task 2.1
- `syncContextWindow` is exported — needed by Task 1.3 (index.ts)
- No new imports needed in provider.ts — `resolveModelRef` already imported, `findModel` is local


#### Task 1.3: Add syncContextWindow call in model_select + session_start handlers (Slice 3)

**Tipe:** AFK
**Issue:** `pi-model-router-ua2` (Slice 3: model_select handler — no blocker)
**Batch:** 1
**Blocker:** Task 1.1 (need `syncContextWindow` exported from provider.ts)
**RED-GREEN Gate:** Test in `provider.test.ts` that verifies `syncContextWindowForSelectedModel` picks first non-cooldowned ref and sets CTW correctly.

##### Files Changed

**`extensions/index.ts`**

1. **Update import** — add `syncContextWindow` to existing import from `./provider.js`:

   Line 4:
   ```typescript
   import { registerRouterProvider, syncContextWindow } from './provider.js'
   ```

2. **Add helper function `syncContextWindowForSelectedModel`** — insert after `updateRouterChainStatus` function (line ~63, before `// --- Hooks ---` comment):

   Exact insertion point (after line 63 `}` closing `updateRouterChainStatus`, before line 66 `// --- Hooks ---`):

   ```typescript
   /** Sync CTW to the first non-cooldowned fallback model for the selected router model. */
   function syncContextWindowForSelectedModel(ctx: ExtensionContext): void {
     const model = ctx.model;
     if (model?.provider !== PROVIDER_NAME) return;
     const cfg = currentConfig.models[model.id];
     if (!cfg) return;
     const activeRef = cfg.models.find((ref) => !isRateLimited(ref));
     if (!activeRef || !modelRegistry) return;
     syncContextWindow(model, activeRef, modelRegistry);
   }

   // --- Hooks ---
   ```

3. **Add call in `session_start` handler** — after `updateRouterChainStatus(ctx)` (line 75):

   Line 75:
   ```typescript
     updateRouterChainStatus(ctx)
   + syncContextWindowForSelectedModel(ctx)
   ```

4. **Add call in `model_select` handler** — after `updateRouterChainStatus(ctx)` (line 79):

   Line 79:
   ```typescript
     updateRouterChainStatus(ctx)
   + syncContextWindowForSelectedModel(ctx)
   ```

##### Implementation Notes
- `currentConfig`, `modelRegistry`, `isRateLimited`, `PROVIDER_NAME`, `syncContextWindow` all accessible from the closure
- `syncContextWindow(model, activeRef, modelRegistry)` — `model` is `ctx.model` from `ExtensionContext`
- No-op cases: non-router model, no non-cooldowned ref, null registry

##### Verification
```bash
npx vitest run extensions/provider.test.ts
```

##### Scope Guard
- Do NOT change `turn_start` handler — CTW is synced at session_start and model_select; turn_start just updates chain status
- Do NOT move `modelRegistry` initialization — stays in `session_start`
- `syncContextWindowForSelectedModel` is a local function, NOT exported


### Batch 2 (sequential — depends on Batch 1): Task 2.1

#### Task 2.1: Add syncContextWindow call after tryModel returns false (Slice 2)

**Tipe:** AFK
**Issue:** `pi-model-router-67b` (Slice 2: error-after-content path — blocked by d1h)
**Batch:** 2
**Blocker:** Task 1.1 (need `syncContextWindow` function in scope)
**RED-GREEN Gate:** Test that verifies CTW synced to next candidate when tryModel returns false (error-after-content).

##### Files Changed

**`extensions/provider.ts`**

1. **Insert CTW sync after `if (succeeded) return;`** — line 589:

   Exact insertion point:

   ```
   588:         );
   589:         if (succeeded) return; // outer IIFE returns, stream already ended inside tryModel
   590:       } catch (err) {
   ```

   Insert between line 589 and line 590:

   ```typescript
         if (succeeded) return; // outer IIFE returns, stream already ended inside tryModel

         // Error-after-content: tryModel returned false → sync CTW to next candidate
         const syncRef = isLast ? ref : candidates[i + 1];
         syncContextWindow(model, syncRef, registry);
       } catch (err) {
   ```

##### Implementation Notes
- `isLast`, `ref`, `candidates`, `model`, `registry` are all accessible in this scope (same for-loop body as the catch block)
- No double-sync risk: `tryModel` either returns `false` (line hits) OR throws (catch block, already synced in Task 1.1). Never both.
- The `i` loop variable is the current iteration index — `candidates[i+1]` is valid when `!isLast`

##### RED-GREEN Gate (test)

Add test in `provider.test.ts` using the existing `errorAfterContentStream` pattern:

```typescript
it('syncs CTW to next candidate when model fails after content', async () => {
  clearRateLimits()
  const config: RouterConfig = {
    models: { test: { models: ['openai/gpt-4', 'anthropic/claude-3'] } },
  }
  const gpt4Model = mockModel({ id: 'gpt-4', provider: 'openai', contextWindow: 32_000 })
  const claudeModel = mockModel({ id: 'claude-3', provider: 'anthropic', contextWindow: 200_000 })
  const registry = {
    find: vi.fn((_p: string, modelId: string) => {
      if (modelId === 'gpt-4') return gpt4Model
      if (modelId === 'claude-3') return claudeModel
      return undefined
    }),
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
  }
  const { streamSimple } = await import('@earendil-works/pi-ai/compat')
  ;(streamSimple as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce(errorAfterContentStream('error', 'Mid-stream failure'))
    .mockReturnValueOnce(successStream())

  const providerCfg = setupRouter(config, registry)
  const routerModel: any = { id: 'test', provider: 'router', api: 'router-local-api', contextWindow: 200_000 }

  const stream = providerCfg.streamSimple(routerModel, ctx, {})
  await (stream as any)._endPromise

  // After error-after-content on gpt-4, CTW should sync to claude-3 (next candidate)
  // gpt-4 CTW = 32000, claude-3 CTW = 200000 — should be 200000
  expect(routerModel.contextWindow).toBe(200_000)
})
```

##### Verification
```bash
npx vitest run extensions/provider.test.ts
```

##### Scope Guard
- Do NOT change `tryModel` function itself — only its call site in routeStream
- Do NOT add sync inside the catch block's fallback notification section
- `syncContextWindow` already available at module scope (Task 1.1)


### Batch 3 (HITL — depends on Batch 1+2): Task 3.1

#### Task 3.1: maxTokens sync + integration sign-off (Slice 4)

**Tipe:** HITL
**Issue:** `pi-model-router-b0d` (Slice 4: maxTokens sync + sign-off — blocked by all)
**Batch:** 3
**Blocker:** Tasks 1.1, 1.3, 2.1
**RED-GREEN Gate:** Manual test that verifies footer shows correct CTW + maxTokens.

##### Files Changed

**`extensions/provider.ts`**

1. **Add `syncMaxTokens()` helper** — same pattern as `syncContextWindow`. Insert after `syncContextWindow`:

   ```typescript
   /** 
    * Sync model.maxTokens to the resolved model's maxTokens.
    * Same pattern as syncContextWindow — direct mutation, no-op on null.
    */
   export const syncMaxTokens = (
     model: { maxTokens: number } | null,
     ref: string,
     registry: ModelRegistry,
   ): void => {
     if (!model) return;
     const resolved = resolveModelRef(ref, registry);
     if (!resolved) return;
     const targetModel = findModel(registry, resolved.provider, resolved.modelId);
     if (!targetModel) return;
     model.maxTokens = targetModel.maxTokens;
   };
   ```

2. **Call `syncMaxTokens` alongside `syncContextWindow`** at all three call sites:

   Catch block (after line 607):
   ```typescript
         // Sync CTW to reflect the next model that will handle requests
         const syncRef = isLast ? ref : candidates[i + 1];
         syncContextWindow(model, syncRef, registry);
         syncMaxTokens(model, syncRef, registry);
   ```

   After tryModel false (after line 589):
   ```typescript
         // Error-after-content: tryModel returned false → sync CTW to next candidate
         const syncRef = isLast ? ref : candidates[i + 1];
         syncContextWindow(model, syncRef, registry);
         syncMaxTokens(model, syncRef, registry);
   ```

**`extensions/index.ts`**

1. **Update import** — add `syncMaxTokens`:

   ```typescript
   import { registerRouterProvider, syncContextWindow, syncMaxTokens } from './provider.js'
   ```

2. **Update `syncContextWindowForSelectedModel`** — also sync maxTokens:

   ```typescript
   function syncContextWindowForSelectedModel(ctx: ExtensionContext): void {
     const model = ctx.model;
     if (model?.provider !== PROVIDER_NAME) return;
     const cfg = currentConfig.models[model.id];
     if (!cfg) return;
     const activeRef = cfg.models.find((ref) => !isRateLimited(ref));
     if (!activeRef || !modelRegistry) return;
     syncContextWindow(model, activeRef, modelRegistry);
     syncMaxTokens(model, activeRef, modelRegistry);
   }
   ```

##### Verification (Manual)
```bash
# 1. Build
npm run build  # if needed

# 2. Start pi, configure router with multi-model fallback
# 3. Verify footer CTW reflects active model (not max across all)
# 4. Trigger fallback — verify CTW updates to next model
# 5. Select router model directly — verify CTW correct
# 6. Check maxTokens matches active model

# 7. Regression
npm test
```

##### Scope Guard
- `syncMaxTokens` is ponytail-simple: same pattern as syncContextWindow, no new abstractions
- No new schema, config, or API changes
- maxTokens is less critical than CTW (no silent data loss), but syncs in same change for completeness

---

## Verification Plan

### Per-Slice Verification

| Slice | Verification Method | Command |
|-------|-------------------|---------|
| 1 (catch block sync) | Provider tests pass, CTW synced after error-before-content | `npm test` |
| 2 (tryModel false sync) | Provider tests pass, CTW synced after error-after-content | `npm test` |
| 3 (model_select sync) | Provider tests pass, CTW correct after model selection | `npm test` |
| 4 (maxTokens + sign-off) | Manual verification of footer + `npm test` | Manual + `npm test` |

### Regression Guard

- `syncContextWindow` must be no-op on null model — existing tests that pass null model must not break
- `syncContextWindow` must be no-op on unfindable ref — registry.find returning null must not throw
- No test in existing suite should depend on `model.contextWindow` not being mutated — verify all 57+ existing tests pass
- `RouterAbortError` path must NOT call sync (already guarded by `if (!isAbort)`)
- Cooldown behaviour (existing tests) must be unaffected

### DOX Pass

After all slices:
1. Check changed paths against DOX chain: `AGENTS.md` root → `docs/` scope
2. Update nearest owning docs if any contract changed (plan.md, approach.md, review.md already exist)
3. Report any docs intentionally left unchanged and why

---

## Halt for Approval

Before implementation begins, review this plan and confirm:

1. **Batch ordering**: Batch 1 (parallel: catch block + model_select) first, Batch 2 (tryModel false) second, Batch 3 (maxTokens + sign-off) third
2. **Direct mutation approach**: `syncContextWindow(model, ref, registry)` — model parameter, not `ctx.model`
3. **maxTokens sync**: Same pattern as CTW, but added in final HITL batch for manual verification
4. **Test strategy**: Add integration tests in `provider.test.ts` using existing mock patterns; no new test file needed
