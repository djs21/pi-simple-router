# Code Review: `add-prompt-caching` OpenSpec

**Reviewed:** proposal.md, design.md, specs/prompt-cache/spec.md, tasks.md
**Verdict:** ❌ NEEDS REVISION

## Summary

The proposal correctly identifies the value of prompt caching and the approach is broadly sound — strip stale markers, stamp breakpoints on system messages and last user message, skip unsupported providers. However, **Decision 2 (hook wiring) has a critical flaw** that would make the entire feature a no-op unless addressed. Several spec details and task items also need refinement.

---

## Findings

### [P0] Decision 2: `before_provider_request` detection logic is broken

**Docs:** `design.md:Decision 2`, `specs/prompt-cache/spec.md:API format detection`

**Issue:** The spec says to detect API format via `ctx.model.api`. But when the hook fires for a *delegated* `streamSimple` call (e.g., `openai/gpt-4o`), `ctx.model` in the hook context is still the **router model** (`provider: 'router'`, `api: 'router-local-api'`), NOT the delegated target model. The hook would always see `api: 'router-local-api'` → detect "unknown" → no-op. Every request would pass through unchanged.

**Root cause:** Tracing the actual dispatch chain in pi's SDK (`sdk.js`, `runner.js`, `compat.js`):

1. Pi calls `streamSimple(routerModel, ctx, { onPayload: agentCallback, ... })`
2. Router's `routeStream` passes `onPayload` through to delegated `streamSimple(targetModel, ctx, { ...options })`
3. The API provider calls `onPayload(payload, targetModel)` — target model IS available here
4. But pi's `onPayload` implementation discards `_model` before calling `runner.emitBeforeProviderRequest(payload)`
5. `emitBeforeProviderRequest` creates ctx from the agent state — `ctx.model` = router model
6. Hook handler receives `event.payload` (correct format) but `ctx.model.api === 'router-local-api'`

**Suggested Fix:** Two options:

**Option A (Recommended — simpler, more robust):** Move stamping inline in `tryModel` / `routeStream`, before the `streamSimple` call. Modify `ctx.messages` directly in pi-ai's internal `Message[]` format. This avoids the hook detection problem entirely and gives direct access to the target model's API type.

**Option B (Keep hook, fix detection):** Inspect `event.payload` structure to determine the API format instead of `ctx.model.api`. E.g., check for `payload.model` (OpenAI) vs `payload.system` (Anthropic). This is fragile — depends on pi-ai's internal serialization format which could change.

Option A is ~10 lines in `tryModel` and eliminates all detection ambiguity. Option B couples the hook to pi-ai's internal payload shape.

---

### [P0] `prompt_cache_key` has no delivery mechanism

**Docs:** `specs/prompt-cache/spec.md:Provider-level prompt_cache_key stamped`, `design.md:Decision 3`

**Issue:** The spec says to attach `prompt_cache_key` "at the provider request level." But when stamping inside `routeStream` (as required by the P0 above), we modify `Context.messages` — NOT the final provider payload. There's no standard mechanism to attach arbitrary metadata to a `streamSimple` call that would reach the provider.

**Additional problem:** Even if we could attach it, `prompt_cache_key` is an OpenCode Go-specific field. OpenAI and Anthropic standard APIs don't accept it. The design says it's "for debugging/cost-tracking only" — but without a clear delivery mechanism, it's dead code.

**Suggested Fix:** Drop `prompt_cache_key` from the MVP scope. It's speculative debugging infrastructure with no clear attachment point. If needed later, ship it as a separate change with a concrete delivery plan (e.g., pi SDK enhancement, or a side-channel log). The cache breakpoints alone deliver the cost savings.

---

### [P1] Anthropic `cache_control` format assumption unverified

**Docs:** `specs/prompt-cache/spec.md:Anthropic-compatible API scenario`

**Issue:** The spec says to inject `cache_control` into content blocks as `{ type: "text", text: "...", cache_control: { type: "ephemeral" } }`. This assumes pi-ai's internal `Message` format maps 1:1 to Anthropic's wire format. But pi-ai uses its own `ContentBlock` type, and the Anthropic serializer may or may not preserve extra properties on content blocks.

With Option A from P0 fix (inline stamping), we'd modify pi-ai `Message` objects, not serialized Anthropic JSON. The `Message` type has `content: string | ContentBlock[]`. We'd need to verify that extra properties on `ContentBlock` survive pi-ai's Anthropic serialization. If not, we'd need to stamp at a different level or use a different mechanism.

**Suggested Fix:** Before implementing, write a 5-line test: create a `Message` with a `ContentBlock` that has `cache_control`, pass through `streamSimple` to Anthropic API (or mock), verify it reaches the wire. If pi-ai strips unknown properties, we need a different approach (e.g., patching the payload in `onPayload` directly).

---

### [P1] Single-message + tool-calls edge case not covered

**Docs:** `specs/prompt-cache/spec.md:Empty or single-message request`

**Issue:** The spec says "WHEN the request has only one message THEN that message SHALL NOT get `cache_control`." But what if that single message is a user message AND the request includes tool definitions? The tool definitions should still get `cache_control` (they're cacheable prefixes). The spec doesn't address this combination.

**Suggested Fix:** Clarify: "Single-message requests SHALL NOT get `cache_control` on the message, BUT tool definitions (if present) SHALL still get `cache_control`." Or better: "Single-message requests with no tool definitions SHALL NOT get `cache_control`."

---

### [P1] Skip list is hardcoded with no extension point

**Docs:** `design.md:Risks/Trade-offs`, `specs/prompt-cache/spec.md:Unsupported model families`

**Issue:** The skip list `['glm', 'zhipu']` is hardcoded. The design acknowledges this risk but proposes no extensibility. If a user wants to add or remove providers, they must edit source code.

**Suggested Fix:** For MVP this is acceptable (noted in the design as "trivial one-line update"). But consider a lightweight escape hatch: check if the model's `api` property is one that's KNOWN to support caching (`openai-completions`, `anthropic-messages`) rather than maintaining a deny-list. A deny-list is always playing catch-up.

---

### [P2] Tasks don't account for P0 architectural change

**Docs:** `tasks.md:Section 3`, `tasks.md:Section 4`

**Issue:** Tasks 3.1–3.7 and 4.1–4.3 assume the hook approach works as-is. If the hook detection is broken (P0), these tasks need restructuring:
- Task 3.1: Function signature changes (no longer a hook handler; becomes a pure function called from `tryModel`)
- Task 4.2: Wiring changes (called inline instead of `api.on`)
- New task: integrate stamping call into `tryModel` before `streamSimple` delegate

**Suggested Fix:** Resolve P0 first, then update tasks to match the chosen approach (inline or fixed-hook).

---

### [P2] Tasks 1.2: Registry cache scope ambiguity

**Docs:** `tasks.md:1.2`

**Issue:** Task 1.2 says "Replace direct `findModel()` calls in `buildModels`, `tryModel`, `routeStream`, `syncContextWindow`". But `buildModels` runs at registration time (once per config load) — caching `findModel` results across config reloads could return stale data if the registry changes. The cache lifecycle is session-scoped, but `buildModels` can be called multiple times per session (on `/router reload`).

**Suggested Fix:** Clarify that `buildModels` should use a fresh cache or bypass the cache entirely. Or ensure the cache is invalidated on config reload.

---

### [P2] "Normalized system text" for SHA-256 is ambiguous

**Docs:** `specs/prompt-cache/spec.md:Prompt cache key computed from system message`

**Issue:** The spec says "SHA-256 hex digest of the normalized system text" but doesn't define normalization. System message content can be `string | ContentBlock[]`. What's the normalization? `JSON.stringify`? `toString()`? This ambiguity would cause different implementations to produce different keys.

**Suggested Fix:** Specify: "If system message content is a string, hash that string. If it's `ContentBlock[]`, extract and concatenate all `text`-typed blocks, then hash. If no system message, return undefined." — but see P0: consider dropping `prompt_cache_key` entirely.

---

### [P2] Testing seams mentioned in tasks but not in spec

**Docs:** `tasks.md:3.7`

**Issue:** Task 3.7 mentions `_setModelForTesting` and `_setCryptoForTesting` as testing seams. The spec doesn't mention these. This is fine for implementation but worth noting — it's an implementation detail, not a requirement.

---

## What's Good

- **Problem statement is clear and well-motivated.** The cost savings are real and the approach is well-understood from prior art (pi-opencode-go-cache).
- **Scope is appropriately limited.** No over-engineering — strip/stamp/strip pattern, no config, no persistence, no analytics beyond the key.
- **Decision 1 (plain `Map` for registry cache) is correct.** The working set is tiny (2-5 entries), LRU adds no value.
- **Decision 3 (SHA-256) is correct and dependency-free.**
- **Spec scenarios are concrete and testable.** Each requirement has clear GIVEN/WHEN/THEN, good coverage of edge cases.
- **Task ordering is logical** — registry cache → auth cleanup → prompt-cache module → wiring → tests.
- **Dirty-strip-then-stamp pattern is exactly right.** Prevents cache marker accumulation across turns.
- **No new dependencies.** Good use of built-in `crypto` and `Map`.

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|-----------|
| P0 | 2 | Hook detection broken; `prompt_cache_key` attachment undefined |
| P1 | 3 | Anthropic format unverified; single-msg+tools edge case; hardcoded skip list |
| P2 | 4 | Tasks need restructuring; registry cache scope; SHA-256 normalization; testing seams |

**Recommended path forward:**
1. Resolve P0 by choosing inline stamping in `tryModel` (Option A) — simpler, more robust, eliminates detection ambiguity
2. Drop `prompt_cache_key` from MVP — re-add as separate change when delivery mechanism exists
3. Verify Anthropic `cache_control` survives pi-ai serialization (5-line test)
4. Update tasks to match the inline approach
5. Address P1 edge cases in spec
