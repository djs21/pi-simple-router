## Context

The pi-model-router extension currently delegates each turn to a fallback chain of underlying provider models. Each delegation is a raw `streamSimple` call — no prompt caching awareness. Major providers (OpenAI, Anthropic, OpenCode Go) support prompt caching, reducing cost by 50–90% on repeated system instructions, tool schemas, and conversation prefixes.

The extension already has a hook system (`session_start`, `model_select`, `turn_start`, `session_shutdown`) and an in-memory auth cache pattern (`Map<string, CachedAuth>`). The proposed change adds the `before_provider_request` hook — a hook that fires right before a request is dispatched to a provider — plus a lightweight registry lookup cache, and auth cache cleanup.

pi-ai already has built-in prompt caching for OpenAI (api.openai.com) and Anthropic, but it does NOT activate for non-standard base URLs like OpenCode Go. Our router extension provides a UNIVERSAL solution and override — we handle ALL providers ourselves, ensuring caching works regardless of base URL or compat flags.

## Goals / Non-Goals

**Goals:**
- Inject `cache_control` breakpoints into messages for ALL supported API formats (OpenAI-compatible and Anthropic-compatible)
- Stamp `prompt_cache_key` (SHA-256 of system message text) + `prompt_cache_retention: "24h"` for OpenAI-compatible requests (enables sticky routing for per-node KV cache)
- Detect the target API format from the **payload structure** (not from `ctx.model.api`, which reports the router's own API format for delegated calls)
- Handle three API formats: `openai-completions`, `anthropic-messages`, and unknown (no-op)
- Skip unsupported model families (`glm`, `zhipu`)
- Strip stale cache markers from incoming payloads before re-stamping
- Add registry lookup caching for `findModel()` and `modelSupportsImage()` to reduce redundant registry queries
- Clear auth cache and registry lookup cache on `session_shutdown`

**Non-Goals:**
- Cache state persistence across sessions (in-memory only, same lifecycle as auth cache)
- Configurable cache control points or types (always `ephemeral`, always on for supported models)
- Prompt caching for multi-modal or streaming-specific optimizations
- Analytics or cost reporting beyond the `prompt_cache_key` stamp

## Decisions

### Decision 1: Plain `Map` for registry lookup cache (not LRU library)
**Choice:** Use a plain `Map<string, { result: … }>` keyed by `${provider}/${modelId}`.
**Rationale:** The registry lookup cache has at most one entry per unique model ref in the fallback chain. Typical configs have 2–5 refs per logical model, so an LRU eviction policy adds complexity for no practical benefit. This matches the existing `authCache` pattern exactly.
**Alternatives considered:** `lru-cache` npm package — unnecessary dependency for such a small working set.

### Decision 2: `before_provider_request` hook detects target format from payload structure
**Choice:** The hook detects the target API format by inspecting the **payload structure** (`event.system`, `event.messages`), not from `ctx.model.api`.
**Rationale:** When pi fires `before_provider_request` for a delegated call through the router, `ctx.model` reports the agent's model (`api: 'router-local-api'`), not the underlying target model. The payload itself (`event`) contains the actual serialized request — `event.model` has the target model ID, and structural clues (`event.system` for Anthropic, `event.messages` for OpenAI-compatible) reveal the format. This is more reliable than any model property.
**Trade-off:** The function becomes format-agnostic and just inspects the data. No access to `ctx.model` needed.
**Alternatives considered:** Wrapping inside `streamSimple` — more invasive and harder to maintain.

### Decision 3: SHA-256 of system message text for `prompt_cache_key`
**Choice:** Compute `prompt_cache_key` as SHA-256 hex digest of the system message text (normalized: whitespace-trimmed, joined if array).
**Rationale:** Unlike session ID (which varies per sub-agent in pi), the system prompt is stable across sub-agents that share the same instructions. Using system text hash means different sub-agents with the same system prompt share `prompt_cache_key` → sticky routing to the same backend node → cache hits across sub-agents. Zero dependencies — `crypto.createHash('sha256')` is built into Node.js.
**Alternatives considered:** Session ID — varies per sub-agent, causing cache misses when switching agents. Provider+model hash — redundant with API key routing.

### Decision 4: Universal stamping (not relying on pi-ai built-in)
**Choice:** Our hook stamps cache markers for ALL providers (OpenAI-compatible AND Anthropic), rather than relying on pi-ai's built-in handling.
**Rationale:** The router extension is the single caching solution — users should not need to install separate extensions or rely on pi-ai internals. Our hook runs in `before_provider_request`, which fires after pi-ai's internal processing, so our stamps override any existing markers. This gives us guaranteed behavior regardless of base URL, compat flags, or pi version.
**Trade-off:** Duplicates some logic pi-ai already has, but guarantees consistency across all providers the router touches.

## Risks / Trade-offs

- **[False positives on unsupported providers]** → The skip list (`glm`, `zhipu`) is hardcoded. If a new provider adds cache support, the list must be updated. Mitigation: trivial one-line update; unknown API format defaults to no-op anyway.
- **[Stale cache markers from pi itself]** → Stripping first handles this correctly. If pi changes marker format, we adapt.
- **[SHA-256 overhead per request]** → Trivial for typical system messages (<1KB); SHA-256 of a few KB is sub-millisecond. Acceptable.
- **[Anthropic cache_control field serialization]** → `before_provider_request` hook receives the serialized JSON payload (not internal pi-ai objects), so `cache_control` objects are plain JS objects. The Anthropic gateway handles them natively. Verified from pi-ai's own anthropic-messages.js which stamps the same structure.
