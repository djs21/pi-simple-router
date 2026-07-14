## 1. Registry lookup cache

- [ ] 1.1 Add `findModelCache` Map and `modelSupportsImageCache` Map in `extensions/provider.ts`, following the same pattern as `authCache` (module-level `Map`, keyed by canonical ref string). Export `clearRegistryLookupCache()` for use by `session_shutdown`.
- [ ] 1.2 Replace direct `findModel()` calls in `buildModels`, `tryModel`, and `modelSupportsImage` to check the cache first. Ensure the cache key format is `${provider}/${modelId}`. (Note: `routeStream` and `syncContextWindow` call `tryModel`, not `findModel` directly.)
- [ ] 1.3 Wire `clearRegistryLookupCache()` into `session_shutdown` in `extensions/index.ts`.

## 2. Auth cache cleanup

- [ ] 2.1 Export `clearAuthCache()` from `extensions/provider.ts` (wraps `authCache.clear()`).
- [ ] 2.2 Call `clearAuthCache()` in the existing `session_shutdown` hook in `extensions/index.ts`.

## 3. Prompt cache module

- [ ] 3.1 Create `extensions/prompt-cache.ts` with the `beforeProviderRequest` hook function. The function signature must match pi's hook contract: `(payload: unknown, ctx: ExtensionContext) => void | Promise<void>`. Detect the target API format from the **payload structure** (not from `ctx.model.api`):
  - `payload.system` present → `anthropic-messages`
  - `payload.messages` present (and no `payload.system`) → `openai-completions`
  - Neither → `unknown` (passthrough)
- [ ] 3.2 Implement `stripStaleCacheControl(payload)` — removes `cache_control` properties from all messages and content blocks before re-stamping. For OpenAI-compatible: iterate `payload.messages` and delete `cache_control` from message objects. For Anthropic: also handle content blocks inside `content` arrays and the `system` array.
- [ ] 3.3 Implement `stampOpenAiCacheControl(payload)` — adds:
  - `cache_control: { type: "ephemeral" }` to the first system/developer message
  - `cache_control: { type: "ephemeral" }` to the last user message
  - `prompt_cache_key` (SHA-256 hex of system text) at the top level
  - `prompt_cache_retention: "24h"` at the top level
  - `cache_control` on tool definitions if `payload.tools` is present (last tool only)
- [ ] 3.4 Implement `stampAnthropicCacheControl(payload)` — adds `cache_control` content blocks for Anthropic's format:
  - First 2 text blocks in `payload.system` array if present
  - Last text content block in the last user message
  - Last tool definition if `payload.tools` is present
  - Follows pi-ai's own patterns from anthropic-messages.js
- [ ] 3.5 Implement `computePromptCacheKey(payload)` — returns SHA-256 hex digest of the system message text (normalized: whitespace-trimmed), or `undefined` if no system message. Uses `crypto.createHash('sha256')`.
- [ ] 3.6 Implement the skip check — return early if the target model ID starts with `glm/` or `zhipu/` (extracted from `payload.model` string).
- [ ] 3.7 Export `beforeProviderRequest` as the hook handler, and `_setCryptoForTesting` / format detection helpers as testing seams.

## 4. Wiring in index.ts

- [ ] 4.1 Import `beforeProviderRequest` from `./prompt-cache.js` in `extensions/index.ts`.
- [ ] 4.2 Add `api.on('before_provider_request', beforeProviderRequest)` in the `routerExtension` function.
- [ ] 4.3 Update the existing `session_shutdown` hook to call `clearAuthCache()` and `clearRegistryLookupCache()`.

## 5. Tests

- [ ] 5.1 Create `extensions/prompt-cache.test.ts` with tests for:
  - `stripStaleCacheControl` strips cache_control from all messages and content blocks
  - `stampOpenAiCacheControl` stamps system and last user message
  - `stampOpenAiCacheControl` stamps prompt_cache_key + retention at top level
  - `stampOpenAiCacheControl` skips single-message requests
  - `stampAnthropicCacheControl` adds cache_control content blocks
  - `computePromptCacheKey` returns SHA-256 hex of system text
  - `computePromptCacheKey` returns undefined when no system message
  - `beforeProviderRequest` skips glm and zhipu models
  - `beforeProviderRequest` passes through unknown API formats
- [ ] 5.2 Update `extensions/provider.test.ts` with tests for registry lookup caching:
  - Repeated `findModel` calls use cache (registry.find called once)
  - Cache cleared on `clearRegistryLookupCache()`
  - `modelSupportsImage` uses cache
