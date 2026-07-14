# Code Review

**Reviewed:** Prompt caching extension + registry lookup cache + auth cleanup
**Verdict:** APPROVED (with minor findings)

## Summary

Prompt caching implementation is solid: format detection is correct, stamping matches Anthropic/OpenAI specs, stripping works properly, and all 113 tests pass. The registry lookup cache and auth cache cleanup in `session_shutdown` are clean additions. Two P1 findings (operator precedence bug, dead handler) and a few P2 notes below.

---

## Findings

### [P1] Operator precedence bug in `getSystemText` find predicate

**File:** `extensions/prompt-cache.ts:91-96`

```typescript
const sys = payload.messages.find(
    (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).role === "system" ||
        (m as Record<string, unknown>).role === "developer",
);
```

`&&` binds tighter than `||`, so this parses as:

```
(typeof m === "object" && m !== null && role === "system") || (role === "developer")
```

If `m` is `null`: the first clause evaluates to false (typeof null === "object" → true, null !== null → false), then the second clause runs `(null as …).role` → **TypeError**. In practice `messages` arrays shouldn't contain null, but the bug is latent.

**Suggested Fix:** Add parentheses:

```typescript
(m) =>
    typeof m === "object" &&
    m !== null &&
    ((m as Record<string, unknown>).role === "system" ||
     (m as Record<string, unknown>).role === "developer"),
```

### [P1] Dead `session_shutdown` handler left behind

**File:** `extensions/index.ts:104-106`

The commit adds a new `session_shutdown` handler to clear caches, but the pre-existing empty one ("nothing to clean up") is still registered. Two handlers fire on every shutdown — harmless but misleading.

**Suggested Fix:** Remove the empty handler:

```typescript
// DELETE these lines:
api.on("session_shutdown", () => {
    // nothing to clean up
});
```

---

### [P2] `stripStaleCacheControl` doesn't clear top-level cache keys

**File:** `extensions/prompt-cache.ts:39-68`

The strip function removes `cache_control` from messages/content blocks but not `prompt_cache_key` and `prompt_cache_retention` from the top-level payload. `stampOpenAiCacheControl` overwrites them anyway, so this only matters if stamping is skipped (e.g., single-message request after caching was previously enabled on the same payload object). Payload reuse is unlikely in practice — P2.

**Suggested Fix:** Add after the blocks loop:

```typescript
delete payload.prompt_cache_key;
delete payload.prompt_cache_retention;
```

### [P2] `stampOpenAiCacheControl` find predicate has same null-safety gap

**File:** `extensions/prompt-cache.ts:108-110`

```typescript
const sysMsg = messages.find(
    (m) => m.role === "system" || m.role === "developer",
);
```

Same null-deref potential as the `getSystemText` bug. Lower impact since this runs after `stripStaleCacheControl` and messages are well-formed. Add the null guard for consistency.

### [P2] Missing test: Anthropic with 3+ system text blocks

**File:** `extensions/prompt-cache.test.ts`

The spec says "first 2 system blocks" get stamped. The test only covers 1 system text block. A test with 3+ text blocks would verify the `stamped >= 2` break condition works as intended.

---

## What's Good

- **All 113 tests pass** — prompt-cache (13), provider (32), config (40), rate-limit-tracker (22), usage-tracker (6)
- **Clean module design** — detect → strip → stamp pipeline is clear and testable
- **Crypto testing seam** (`_setCryptoForTesting`) avoids mocking `node:crypto`
- **Cache invalidation wired correctly** — `clearAuthCache()` + `clearRegistryLookupCache()` on `session_shutdown`
- **Smart OpenRouter lookup** now benefits `buildModels` (was previously only in `tryModel`)
- **Model skip** (`glm/*`, `zhipu/*`) short-circuits before any mutation — correct
- **Single-message guard** (`messages.length <= 1`) prevents stamping when there's nothing to cache
- **Error-before-content handling** leaves stale cache-control from previous turn; strip + re-stamp pattern is robust against retries
