# Cache Research Findings — pi-ai Built-in vs Extension Hook

## Konfirmasi Reviewer P0

**✅ Reviewer benar.** `ctx.model.api` di `before_provider_request` hook adalah model AGENT (router kita, `api: 'router-local-api'`), BUKAN delegated target model.

**Bukti dari source:**

- `sdk.js:212`: `onPayload: async (payload, _model)` — parameter `_model` (target model) tersedia di callback tapi **dibuang** (prefix `_`), tidak diteruskan ke `runner.emitBeforeProviderRequest(payload)`.
- `runner.js:724`: `emitBeforeProviderRequest(payload)` — cuma nerima `payload`, bikin `ctx` dari `createContext()` yang pake `getModel()` dari agent state.
- `runner.js:450`: `ctx.model` = `getModel()` = model yang dipilih user (yaitu router model kita).

## Insight Penting: pi-ai SUDAH Handle Prompt Caching

**OpenAI completions** (`openai-completions.js:423-440`):

- `prompt_cache_key`: Set otomatis kalo `model.baseUrl.includes("api.openai.com")` ATAU `(cacheRetention === "long" && compat.supportsLongCacheRetention)`. Pake `options?.sessionId`.
- `prompt_cache_retention`: `"24h"` kalo `cacheRetention === "long"`.
- `cache_control`: via `getCompatCacheControl(compat, cacheRetention)` — ke tools + text parts.
- `cacheRetention`: dari `options?.cacheRetention` fallback ke `env.PI_CACHE_RETENTION`.

**Anthropic messages** (`anthropic-messages.js:672-712`):

- `cache_control`: Native support di system prompt (2 blocks), messages (last user), tools (last tool).
- Kompatibilitas via `model.compat.supportsLongCacheRetention` dan `model.compat.supportsCacheControlOnTools`.
- Juga pake `options?.cacheRetention` dan `options?.env`.

## Kenapa pi-opencode-go-cache Ada?

Karena untuk **OpenCode Go models**:

- `baseUrl` = `https://go.opencode.ai` → TIDAK mengandung `api.openai.com`
- Bail di `prompt_cache_key` condition → key gak di-set
- `compat.supportsLongCacheRetention` mungkin `false` → gak ada kondisi alternatif
- Markers `cache_control` juga skipped

Jadi pi-opencode-go-cache nge-stamp manual via `before_provider_request` hook. Ini solusi yang tepat — hook dapat payload FINAL yang siap dikirim ke gateway.

## Implikasi untuk Model Router Kita

### Yang SUDAH jalan tanpa kita sentuh

- **OpenAI direct** (api.openai.com): Built-in caching jalan kalo `PI_CACHE_RETENTION=long` di env
- **Anthropic direct**: Built-in caching jalan dengan config yang sesuai
- **Google Gemini**: Built-in `cachedContent` API (berbeda)

### Yang PERLU kita tambah

- **OpenCode Go** (dan non-standard providers): `before_provider_request` hook untuk stamp `cache_control` markers
- Kita TIDAK perlu stamp `prompt_cache_key` — itu spesifik OpenCode Go dan sudah di-handle pi-opencode-go-cache kalo user install

### Fix untuk Detection

Hook masih viable — tapi jangan pake `ctx.model.api`. Alternatif:

**Opsi A: Deteksi dari payload structure**

```typescript
// openai-completions payload: { model: "...", messages: [...], stream: true, ... }
// anthropic-messages payload: { model: "...", messages: [...], system: [...], ... }
function detectApiFormat(payload: Record<string, unknown>): string {
    if (payload.system !== undefined) return 'anthropic-messages';
    if (payload.messages !== undefined) return 'openai-completions';
    return 'unknown';
}
```

Ini yang dilakukan pi-opencode-go-cache secara implisit — mereka cek `model.api` di `ctx` tapi itu spesifik opencode-go. Kita generalisir.

**Opsi B: Inline stamping di tryModel — modify ctx.messages**

- Kita punya akses ke `targetModel.api` (nilainya bener: `openai-completions`, `anthropic-messages`)
- Tapi ini ngubah `Context.messages` pi-ai internal — perlu verifikasi apakah extra properties survive serialisasi

### Rekomendasi: Opsi A (payload detection)

Lebih sederhana, hook approach tetap dipake, gak perlu modifikasi `provider.ts` logic. Cukup:

1. Hook `before_provider_request` di `prompt-cache.ts`
2. Detek format dari payload (gak perlu `ctx.model`)
3. Untuk `openai-completions`: stamp `cache_control` di messages + tools
4. Untuk `anthropic-messages`: skip (pi-ai built-in sudah handle)
5. Skip unsupported models (glm, zhipu — via payload.model match)

### `prompt_cache_key` → Drop dari MVP

Alasan:

- Spesifik OpenCode Go — gak diterima OpenAI/Anthropic API standard
- Kalo user pake pi-opencode-go-cache, mereka handle
- Gak ada delivery mechanism yg reliable via inline approach
- Cache breakpoints doang udah deliver cost saving utama

## Kesimpulan

MVP kita lebih sederhana dari yang diduga:

1. **File `extensions/prompt-cache.ts`** — hook `before_provider_request` yang:
   - Detek format dari payload structure
   - Stamp `cache_control` breakpoints untuk `openai-completions` format
   - Skip `anthropic-messages` (built-in)
   - Skip unsupported models
2. **Registry lookup cache** di `provider.ts` — Map pattern (sama kayak authCache)
3. **Auth cache cleanup** — `authCache.clear()` di `session_shutdown`

Perubahan dari draft planner:

- ❌ `prompt_cache_key` — drop
- ❌ Anthropic stamp — skip (built-in)
- ⚠️ Detection method: payload structure, bukan `ctx.model.api`
