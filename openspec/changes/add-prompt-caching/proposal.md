## Why

Prompt caching is supported by major providers (OpenAI, Anthropic, OpenCode Go, and others) and can dramatically reduce API costs — often 50–90% on repeated prompt prefixes like system instructions, tool definitions, and conversation history. The router currently delegates to underlying models without any prompt caching awareness, leaving money on the table every turn. Adding a `before_provider_request` hook that stamps cache-control markers for ALL provider formats means existing router users get cost savings transparently, with zero config changes — no extra extensions needed.

## What Changes

- **New `extensions/prompt-cache.ts`** — universal prompt caching module that handles all API formats from a single hook:
  1. `before_provider_request` hook that detects the target API format from the **payload structure** (not from `ctx.model.api`, which is unreliable for delegated calls).
  2. Handles three API formats:
     - **OpenAI-compatible** (`openai-completions`): stamps `cache_control` on message objects, `prompt_cache_key` (SHA-256 of system text), and `prompt_cache_retention: "24h"` at the request level.
     - **Anthropic-compatible** (`anthropic-messages`): stamps `cache_control` on content blocks inside messages and the system array.
     - **Unknown** (unsupported): passthrough, no-op.
  3. Strips stale cache-control markers from incoming payloads before re-stamping (prevents accumulation across turns).
  4. Skips models from providers known not to support prompt caching (`glm/*`, `zhipu/*`).
- **Registry lookup cache** — wrap `findModel()` and `modelSupportsImage()` with a simple `Map` (like the existing `authCache`) to avoid redundant registry lookups on every fallback candidate check.
- **Auth cache cleanup** — add `authCache.clear()` in the existing `session_shutdown` hook.
- **Wiring in `extensions/index.ts`** — install the `before_provider_request` hook and add `session_shutdown` cleanup for the auth and registry caches.

## Capabilities

### New Capabilities
- `prompt-cache`: Universal prompt caching injection for ALL supported provider APIs (OpenAI-compatible, Anthropic-compatible). Detects the target format from the payload structure, stamps `cache_control` breakpoints, sets `prompt_cache_key` + `prompt_cache_retention` for OpenAI-compatible, and strips stale markers. No-op for unknown API formats and unsupported model families.

### Modified Capabilities
<!-- No existing specs are modified — all changes are additive. -->

## Impact

- **New file:** `extensions/prompt-cache.ts` (~120 lines)
- **Modified files:** `extensions/index.ts` (hook wiring + auth/registry cache cleanup), `extensions/provider.ts` (registry lookup cache)
- **No new dependencies** — all logic uses built-ins (`Map`, `crypto`)
- **No config changes** — prompt caching is always-on for supported models
- **No breaking changes** — existing behavior is unchanged for unsupported models and API formats
