# PRD: Dynamic Context Window Update

## Problem Statement

The router extension registers a single "router" model with pi. Pi's internal state (`agent.state.model`) references this router model object, not the actual active fallback model. The footer reads `agent.state.model.contextWindow` to display context usage — showing the **maximum CTW across all models in the fallback chain**, not the CTW of the model currently handling the request.

This causes three concrete problems:

1. **Wrong auto-compaction threshold** — pi triggers auto-compaction based on the router model's CTW. If the active fallback model has a smaller CTW than the max, compaction may not trigger in time, leading to overflow.
2. **Wrong maxTokens** — pi's maxTokens calculation uses the router model's CTW. An API request to a smaller-CTW model may exceed the real limit and get rejected (413).
3. **Misleading footer display** — the footer shows the max CTW across all fallback models, not the active model's actual capacity. Users can't tell how much context they really have.

## Solution

**Direct mutation of `ctx.model.contextWindow`** when the active model changes at runtime. The model object is a plain JS object referenced by `agent.state.model` — mutating its `contextWindow` property propagates to the footer and all pi internals that read from it.

No re-registration, no `setModel`, no model switch event, no user notification.

## User Stories

1. As a router user, I want the footer CTW to reflect the actual active model's context window, so that I know my real available context.
2. As a router user, I want pi's auto-compaction to trigger at the correct threshold, so that I don't lose data from overflow.
3. As a router user, I want CTW updates to be silent (no model change notification), so that my workflow isn't interrupted.
4. As a developer, I want the CTW update to be testable via integration tests, so that I can verify correctness.

## Implementation Decisions

### Approach: Direct Mutation (Opsi C)

- Mutation point: one centralized function `syncContextWindow(ctx, ref)` that:
  1. Looks up the model ref in `modelRegistry`
  2. Sets `ctx.model.contextWindow = resolvedModel.contextWindow`
- Called from three sites:
  - **`model_select` event handler** — when user selects the router model, set CTW from the first non-cooldowned fallback model
  - **`routeStream` catch block** — after marking a model rate-limited, update CTW to reflect the *next* model in the chain (the one that will be used next turn)
  - **`tryModel` error-after-content handler** — same as above, after content was already sent
- CTW value fetched via `findModel(registry, provider, modelId)` — the same lookup `routeStream` uses for delegation

### Why Direct Mutation Works

From the investigation:
- Footer reads from `agent.state.model.contextWindow` (AgentSession line 2415 via `getContextUsage()`)
- `agent.state.model` is a reference to the model object registered by the extension
- `contextWindow` is a plain JS number property — no getter/setter, no internal bookkeeping to bypass
- Mutating `ctx.model.contextWindow` changes what the footer reads **immediately**, without any API call or event

### What Does NOT Work (and why)

- **Re-register + re-select**: `registerProvider()` replaces models in the registry, but `agent.state.model` still references the old object. Would need `setModel()` which triggers a `model_select` event and shows a "model changed" notification. Unnecessary side effects.
- **Custom footer**: `ctx.ui.setFooter()` replaces the entire footer, losing built-in features (auto-compact indicators, git branch, etc.). Too heavyweight for a one-line fix.
- **No dedicated API exists**: `pi.updateModel()`, `pi.setModelMetadata()`, `registerModel()` do not exist in the ExtensionAPI.

### Why Not Update maxTokens

`maxTokens` affects pi's request construction (how many tokens it asks the model to generate). Mismatch here means pi may request more tokens than the active model supports, but graceful degradation (truncation, partial response) still works. Data loss from CTW mismatch (overflow before compaction) is **silent and complete** — entire conversation history gets truncated. CTW is the critical property to fix first. `maxTokens` is a separate concern (future PRD).

## Implementation Plan

### Files to Change

**`extensions/provider.ts`**:
- Add a helper function `syncContextWindow(ctx, ref)`:
  ```typescript
  const syncContextWindow = (
    ctx: Context,
    ref: string,
    registry: ModelRegistry,
  ): void => {
    const resolved = resolveModelRef(ref, registry);
    if (!resolved) return;
    const targetModel = findModel(registry, resolved.provider, resolved.modelId);
    if (!targetModel || !ctx.model) return;
    ctx.model.contextWindow = targetModel.contextWindow;
  };
  ```
- Call `syncContextWindow` in the `routeStream` catch block right after `markRateLimited` — but only for the non-last model (since the next candidate will be tried). And when all candidates are exhausted, set to the last attempted model's CTW.
- Call `syncContextWindow` in `tryModel` error-after-content handler right after `markRateLimited`.

**`extensions/index.ts`**:
- In `model_select` handler: after `updateRouterChainStatus`, call `syncContextWindow` with the first non-cooldowned model ref.

### What Gets the CTW Set To

- **On `model_select`**: the first non-cooldowned fallback model's CTW
- **On fallback error (not last model)**: the *next* candidate's CTW (the one that will handle the next turn)
- **On fallback error (last model)**: the last attempted model's CTW (still better than max across all)
- **On error-after-content**: same as fallback error — next non-cooldowned candidate's CTW

### No Schema or API Changes

- No new types, no new config fields, no new database tables
- `ContextWindow` value is already available in the registry at all times
- The mutation is purely runtime state — no persistence needed

## Testing Decisions

### Seam: Integration via `provider.test.ts`

- No new test file needed. The existing `provider.test.ts` already tests fallback and cooldown behaviour.
- New test: verify `getActiveRateLimits()` returns an entry with the CTW matching the active model (after a fallback scenario).
- Test pattern: mock `streamSimple` delegates to simulate failure chain, then assert `ctx.model.contextWindow` has been updated.

### Seam: Unit via `rate-limit-tracker.test.ts`

- Ponytail: no new tests here. The `syncContextWindow` function is trivial — a registry lookup followed by an assignment. It would just test that `registry.find` works, which is tested by the registry's own tests.

### Prior Art

- `extensions/provider.test.ts` mocks `streamSimple` from `@earendil-works/pi-ai/compat`
- Cooldown behaviour tests already exist in the same file — follow the same `delegatedStream` pattern

## Out of Scope

- **Custom footer** (`ctx.ui.setFooter()`) — too heavyweight, lose built-in features
- **Re-register + setModel** — backup approach, only implement if direct mutation proves insufficient
- **maxTokens synchronization** — separate PRD if needed
- **Multi-router context tracking** — future concern
- **Error type display** — handled by the cooldown PRD (`/router status` error type display)

## Further Notes

- Direct mutation relies on internal pi implementation details (`agent.state.model` reference, plain property assignment). This is not a documented API surface. If pi changes how it manages model metadata, this approach breaks. The risk is acceptable because:
  - The alternative (re-register + re-select) also relies on undocumented internals (that `registerProvider` immediately affects `modelRegistry`)
  - A break would manifest as the footer showing the wrong CTW — same problem we're solving, no data corruption
  - The fix is one line and can be replaced if pi adds a proper API
- The `syncContextWindow` function is intentionally kept as a local helper in `provider.ts` rather than extracted to a separate module. It has exactly one call site pattern (inside the routeStream closure) and no external consumers. Ponytail: skip the abstraction, keep it local.
