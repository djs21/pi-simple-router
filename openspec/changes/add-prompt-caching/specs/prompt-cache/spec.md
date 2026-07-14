## ADDED Requirements

### Requirement: Prompt cache markers injected into messages
The system SHALL inject `cache_control` breakpoints into messages before forwarding to provider APIs. The hook SHALL strip any existing `cache_control` properties from incoming messages before re-stamping (preventing accumulation across turns). The hook SHALL stamp `cache_control: { type: "ephemeral" }` on the following message positions:

- The **system message** (first message with `role: 'system'` or `role: 'developer'`)
- The **last user message** (the most recent message with `role: 'user'`)
- **Tool definitions** if present in the request

Messages without a matching role SHALL NOT be modified.

#### Scenario: Cache control stamped on system message
- **WHEN** the request contains a system message as the first message
- **THEN** the system message SHALL have `cache_control: { type: "ephemeral" }` set

#### Scenario: Cache control stamped on last user message
- **WHEN** the request contains one or more user messages
- **THEN** the last user message SHALL have `cache_control: { type: "ephemeral" }` set

#### Scenario: Stale cache control stripped first
- **WHEN** incoming messages already have `cache_control` properties (e.g. from a previous turn)
- **THEN** all existing `cache_control` properties SHALL be removed before re-stamping

#### Scenario: Tool definitions get cache control
- **WHEN** the request payload includes a `tools` array at the top level
- **THEN** `cache_control: { type: "ephemeral" }` SHALL be added to the tools definition

#### Scenario: Empty or single-message request
- **WHEN** the request has only one message
- **THEN** that message SHALL NOT get `cache_control` (preventing a no-op cache entry)

### Requirement: Provider-level prompt_cache_key stamped
The system SHALL compute a `prompt_cache_key` from the serialized system message content (if present) and attach it at the provider request level. The key SHALL be a SHA-256 hex digest of the normalized system text. This enables downstream cost tracking and debugging.

#### Scenario: Prompt cache key computed from system message
- **WHEN** the request has a system message with text content
- **THEN** the provider request SHALL include `prompt_cache_key` set to the SHA-256 hex digest of the system text

#### Scenario: No system message, no cache key
- **WHEN** the request has no system message
- **THEN** no `prompt_cache_key` SHALL be attached

### Requirement: API format detection
The system SHALL detect the request API format from the model's `api` property and apply format-specific logic:

- `openai-completions`: Inject `cache_control` into message objects directly. Stamp `prompt_cache_key` at the provider level.
- `anthropic-messages`: Inject `cache_control` into message content blocks (Anthropic's format uses per-content-block breakpoints). Stamp `prompt_cache_key` at the provider level.
- `unknown` or unsupported: Pass through all messages unchanged, no cache markers.

#### Scenario: OpenAI-compatible API
- **WHEN** the target model has `api: 'openai-completions'`
- **THEN** `cache_control` SHALL be added to the top-level message objects

#### Scenario: Anthropic-compatible API
- **WHEN** the target model has `api: 'anthropic-messages'`
- **THEN** `cache_control` SHALL be added as content block entries (i.e. inside the `content` array of the message, as `{ type: "text", text: "...", cache_control: { type: "ephemeral" } }`)

#### Scenario: Unknown API format
- **WHEN** the target model's `api` property is neither `openai-completions` nor `anthropic-messages`
- **THEN** messages SHALL pass through unchanged

### Requirement: Unsupported model families skipped
The system SHALL skip prompt caching (no-op) for models from providers that do not support it. The skip list includes `glm` and `zhipu` prefixes.

#### Scenario: GLM model skipped
- **WHEN** the target model's provider is `glm` (e.g. `glm/glm-4`)
- **THEN** no cache markers SHALL be injected

#### Scenario: Zhipu model skipped
- **WHEN** the target model's provider is `zhipu` (e.g. `zhipu/glm-4`)
- **THEN** no cache markers SHALL be injected

#### Scenario: Supported model gets caching
- **WHEN** the target model's provider is not in the skip list (e.g. `openai`, `anthropic`, `google`)
- **THEN** cache markers SHALL be injected normally

### Requirement: Registry lookup caching
The system SHALL cache registry lookup results (`findModel()` and `modelSupportsImage()`) to avoid redundant ModelRegistry.find calls during fallback iteration. The cache SHALL use an in-memory `Map` with the same lifecycle as the auth cache (created per-session, cleared on `session_shutdown`).

#### Scenario: Repeated lookup uses cache
- **WHEN** `findModel(registry, provider, modelId)` is called twice with the same arguments
- **THEN** the second call SHALL return the cached result without calling `registry.find`

#### Scenario: Cache cleared on shutdown
- **WHEN** `session_shutdown` fires
- **THEN** the registry lookup cache SHALL be cleared

### Requirement: Auth cache cleanup on shutdown
The system SHALL clear the auth cache (`authCache` Map) when `session_shutdown` fires, preventing stale auth state from leaking across sessions.

#### Scenario: Auth cache cleared on shutdown
- **WHEN** `session_shutdown` fires
- **THEN** `authCache.clear()` SHALL be called
