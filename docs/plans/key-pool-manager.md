# Plan: Key Pool Manager — Centralized API Key Management + Rolling Keys

## Purpose

Extend the pi-simple-router extension jadi **model manager** — gak cuma fallback routing, tapi juga manage API keys di satu tempat. User taruh semua API keys di satu file, extension handle auth, rotation, cooldown, dan fallback. User tinggal pilih `router/worker` dan semua urusan key urusan extension.

---

## Problem Statement

Saat ini:
1. **API keys tersebar** — env var, `~/.pi/agent/models.json`, provider config. Ribet manage.
2. **Satu key per provider** — kena rate limit? User手动 ganti key.
3. **Auth flow terpisah** — router extension panggil `registry.getApiKeyAndHeaders()`, yang berarti auth masih tergantung pi built-in system.
4. **No key health tracking** — gak tau key mana yang lagi cooldown / expired / invalid.

Yang dimau:
1. Semua API keys di **satu file** (`router-keys.json`)
2. **Multiple keys per provider** — misal 3 OpenRouter keys buat rolling
3. **Auto-rotate** — kena rate limit, otomatis pake key berikutnya
4. **Health tracking** — tau key mana yang sehat, cooldown, atau mati
5. **Seamless UX** — user tinggal setup sekali, sisanya extension handle

---

## Design Decisions

| Keputusan | Pilihan | Alasan |
|---|---|---|
| **Key storage** | File JSON terpisah (`router-keys.json`) | Pisah dari model config biar gak campur aduk. Global + project merge |
| **Encryption** | Skip v1 (plaintext) | Bisa tambah nanti. File permission `chmod 600` cukup untuk sekarang |
| **Fallback auth** | Key pool fallback ke pi built-in auth | Kalo provider gak terdaftar di key pool, pake auth pi biasa. **No breaking change** |
| **Strategy default** | `round-robin` | Fair distribution. User bisa ganti ke `fallback` |
| **Rotation trigger** | Error-based (rate limit, 429, 5xx) + cooldown timer | Sederhana, gak perlu overhead monitoring |
| **Key validation** | Lazy — validasi pas pertama dipake | Bisa tambah `/router keys test` buat manual validation nanti |
| **State persistence** | In-memory only (session-scoped) | Cooldown state ilang pas restart. Intentional — gak perlu file lock |
| **Pi integration** | Auth lookup DI DALAM `streamSimple`, bukan `before_provider_request` | Kontrol penuh. Provider lain gak kena impact |

---

## Config Schema

**File:** `~/.pi/agent/router-keys.json` (global) + `.pi/router-keys.json` (project, merge)

```jsonc
{
  "providers": {
    "openrouter": {
      "keys": [
        "sk-or-v1-aaaa...",
        "sk-or-v1-bbbb...",
        "sk-or-v1-cccc..."
      ],
      "strategy": "round-robin",
      "headers": {
        "HTTP-Referer": "https://pi.dev",
        "X-Title": "pi-simple-router"
      }
    },
    "opencode-go": {
      "keys": ["sk-xxx..."],
      "strategy": "fallback"
    },
    "anthropic": {
      "keys": ["sk-ant-..."]
    }
  }
}
```

### Fields

| Field | Required | Default | Description |
|---|---|---|---|
| `providers` | Yes | — | Object key = provider name (sama kayak di pi: `openrouter`, `opencode-go`, dll) |
| `providers[].keys` | Yes | — | Array of API keys. Urutan = prioritas buat `fallback`, giliran buat `round-robin` |
| `providers[].strategy` | No | `"round-robin"` | `"round-robin"` — gantian. `"fallback"` — pake key1 dulu, baru key2 kalo error |
| `providers[].headers` | No | `{}` | Custom headers buat provider itu (kayak HTTP-Referer buat OpenRouter). **Key pool headers fully replace pi built-in headers** untuk provider yang dikelola key pool. Gak ada deep merge — user explicit configure di file ini, jadi yang dipake dari sini. |

### Security Warning: Git Exposure

> **⚠️ JANGAN commit `.pi/router-keys.json` ke git.** File ini berisi API keys plaintext.
>
> **Rekomendasi:**
> 1. Simpan keys di **global scope** (`~/.pi/agent/router-keys.json`) — aman dari git.
> 2. Project scope (`.pi/router-keys.json`) hanya untuk override konfigurasi kalo terpaksa.
> 3. File `router-keys.json` harus ditambahkan ke `.gitignore`.
> 4. Set permission: `chmod 600 .pi/router-keys.json`

---

## Architecture

### File Changes

```
extensions/
├── index.ts                 ← Mod: load key pool + wiring
├── provider.ts              ← Mod: auth lookup ganti ke key pool
├── commands.ts              ← Mod: /router keys submenu
├── types.ts                 ← Mod: nambah tipe key pool
├── config.ts                ← Mod: nambah keys config loader (minor)
│
├── key-pool.ts              ← 🆕 Key pool manager (inti)
├── keys-config.ts           ← 🆕 Load/save router-keys.json
└── keys-commands.ts         ← 🆕 /router keys submenu handler
```

### Module Responsibilities

#### `key-pool.ts` (BARU)
- `ModelKeyPool` class — in-memory manager
- `getNextKey(provider)` — ambil key berikutnya sesuai strategy
- `markFailed(provider, apiKey, error)` — cooldown key
- `markSuccess(provider, apiKey)` — reset health
- `getStatus()` — report semua pool + health status
- `reload(config)` — reload dari config baru
- `clear()` — reset semua state (session shutdown)

Internal state:
```typescript
class ModelKeyPool {
  private pools: Map<string, ProviderPool>
  
  // ProviderPool:
  //   keys: string[]               — original key list
  //   strategy: RotationStrategy
  //   index: number                 — round-robin counter
  //   health: Map<string, KeyHealth>
  //   customHeaders: Record<string, string>
}
```

#### `keys-config.ts` (BARU)
- `loadKeysConfig()` — baca global + project `router-keys.json`, merge
- `normalizeKeysConfig(raw)` — validasi + normalize
- `saveKeysConfig(config, scope)` — write ke file
- `resolveKeyPath(scope)` — dapatkan path file

#### `provider.ts` (MODIF)

Ada 3 perubahan di `provider.ts`:

**a. Auth lookup — pake key pool, pass ke `tryModel`:**

```typescript
// Di routeStream, pas mau panggil tryModel:

// Ambil auth dari key pool (kalo provider terdaftar)
const keyAuth = keyPool?.getNextKey(targetModel.provider);

// Pass keyAuth sebagai parameter ke tryModel
const succeeded = await tryModel(
  ref, targetModel, ctx, options, reasoningOption,
  stream, output, config, registry,
  i, candidates.length, elapsedStart,
  keyAuth,  // ← PARAMETER BARU: auth dari key pool (atau null)
);
```

**b. Di `tryModel()`, ganti auth lookup pake parameter:**

```typescript
async function tryModel(
  ref: string,
  targetModel: Model<Api>,
  ctx: Context,
  options: SimpleStreamOptions | undefined,
  reasoningOption: Record<string, unknown>,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  config: RouterConfig,
  registry: ModelRegistry,
  refIdx: number,
  totalRefs: number,
  elapsedStart: number,
  keyPoolAuth: { apiKey: string; headers: Record<string, string> } | null,  // ← BARU
): Promise<boolean> {
  // ...

  // OLD:
  // const auth = await getCachedAuth(targetModel, registry);

  // NEW: pake key pool auth kalo ada, fallback ke registry
  const auth = keyPoolAuth ?? await getCachedAuth(targetModel, registry);

  // ...
```

Kalo key pool gak punya provider itu → `keyAuth` = null → `getCachedAuth` dipake = **no breaking change**.

**c. `markFailed` — ALWAYS call (gak digate `isTransientError`):**

```typescript
// Di catch block tryModel (kalo stream gagal):
if (keyPoolAuth) {
  keyPool.markFailed(targetModel.provider, keyPoolAuth.apiKey, err);
  // markFailed internal handle error classification:
  //   429/rate-limit → cooldown
  //   401/403       → dead
  //   5xx           → cooldown pendek
  //   lainnya       → cooldown sebentar
}
```

**d. `markSuccess` — panggil pas stream sukses:**

```typescript
// Di routeStream, pas tryModel berhasil:
try {
  const succeeded = await tryModel(...);
  if (succeeded) {
    if (keyAuth) {
      keyPool.markSuccess(targetModel.provider, keyAuth.apiKey);  // ← BARU
    }
    return;  // stream sudah ended di dalam tryModel
  }
} catch (err) {
  // error handling...
}
```

Kalo `markSuccess` gak dipanggil, health tracking gak pernah reset — failures numpuk terus walau key sebenernya udah pulih.

#### `index.ts` (MODIF)
- Import key pool
- Init key pool di `session_start`
- Pass key pool ke `registerRouterProvider()`
- Cleanup di `session_shutdown`

#### `types.ts` (MODIF)
Nambah:
```typescript
export interface KeyPoolConfig {
  providers: Record<string, ProviderKeyConfig>
}

export interface ProviderKeyConfig {
  keys: string[]
  strategy?: 'round-robin' | 'fallback'
  headers?: Record<string, string>
}

export interface KeyHealth {
  status: 'healthy' | 'cooldown' | 'dead'
  until?: number
  failures: number
  usageCount: number
  lastUsed?: number
}
```

#### `keys-commands.ts` (BARU)
Command `/router keys` dengan sub-submenu:
```
/router keys status     — Lihat semua key pools + health per key
/router keys reload     — Reload dari file
/router keys add <p>   — Tambah key ke provider (input aman)
/router keys remove <p> — Hapus key dari provider (pake selector)
/router keys test <p>  — Test semua keys (ping API /models)
```

Integrasi ke `commands.ts` — `/router` tanpa subcommand = main menu (existing). `/router keys` = submenu baru.

---

## Key Rotation Logic (Core)

### Round-Robin Strategy

```typescript
getNextKey(provider: string): { apiKey: string; headers: Record<string, string> } | null {
  const pool = this.pools.get(provider)
  if (!pool || pool.keys.length === 0) return null

  // Filter healthy keys (skip cooldown & dead)
  const healthy = pool.keys.filter(k => {
    const h = pool.health.get(k)
    return !h || h.status === 'healthy'
  })
  if (healthy.length === 0) return null

  // Round-robin: increment index across healthy keys
  const key = healthy[pool.index % healthy.length]
  pool.index = (pool.index + 1) % healthy.length

  // Update usage
  const health = pool.health.get(key) ?? { status: 'healthy', failures: 0, usageCount: 0 }
  health.usageCount++
  health.lastUsed = Date.now()
  pool.health.set(key, health)

  return { apiKey: key, headers: this.resolveHeaders(provider) }
}
```

### Fallback Strategy

```typescript
getNextKey(provider: string): ... {
  // Coba keys secara urut, skip yang cooldown/dead
  const pool = this.pools.get(provider)
  if (!pool) return null

  for (const key of pool.keys) {
    const h = pool.health.get(key)
    if (h && h.status !== 'healthy') continue

    // Update usage
    const health = h ?? { status: 'healthy', failures: 0, usageCount: 0 }
    health.usageCount++
    health.lastUsed = Date.now()
    pool.health.set(key, health)

    return { apiKey: key, headers: this.resolveHeaders(provider) }
  }
  return null // all keys cooldown/dead
}
```

### Error Handling (markFailed)

```typescript
markFailed(provider: string, apiKey: string, error: unknown): void {
  const pool = this.pools.get(provider)
  if (!pool) return

  const health = pool.health.get(apiKey) ?? { status: 'healthy', failures: 0, usageCount: 0 }
  health.failures++

  // Defensive: error mungkin bukan instanceof Error
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  if (isRateLimitError(error)) {
    // Rate limit → cooldown 5 menit
    health.status = 'cooldown'
    health.until = Date.now() + rateLimitCooldownMs
  } else if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api key')) {
    // 401/403 → mark dead (gak bakal dipake lagi)
    // TAPI: simpan timestamp kematian buat recovery
    health.status = 'dead'
    health.until = Date.now() + 3_600_000  // coba lagi setelah 1 jam
  } else if (isServerError(error)) {
    // 5xx → cooldown pendek (1 menit)
    health.status = 'cooldown'
    health.until = Date.now() + 60_000
  } else {
    // Error lain → cooldown sebentar
    health.status = 'cooldown'
    health.until = Date.now() + 30_000
  }

  pool.health.set(apiKey, health)
}
```

### Lazy Health Recovery (includes Dead Recovery)

Key yang cooldown otomatis balik `healthy` pas `until` lewat. Key `dead` juga punya time-based recovery — setelah 1 jam, dicoba lagi.

```typescript
const isHealthy = (key: string): boolean => {
  const h = pool.health.get(key)
  if (!h) return true

  // Cooldown expired → balikin ke healthy
  if (h.status === 'cooldown' && h.until && Date.now() >= h.until) {
    h.status = 'healthy'
    h.until = undefined
    return true
  }

  // Dead juga ada expiry — 401/403 bukan selalu permanen
  // OpenRouter kadang 401 valid key pas upstream rotation
  if (h.status === 'dead' && h.until && Date.now() >= h.until) {
    h.status = 'healthy'
    h.until = undefined
    return true
  }

  return h.status === 'healthy'
}
```

Kalo user mau revive manual: `/router keys clearcache` reset semua state. Atau nanti bisa ditambah `/router keys revive <provider>` buat per-key.

---

## Integration Points

### Auth Cache (Existing)

Sekarang `provider.ts` punya `authCache` — Map of provider/model → apiKey+headers.

Dengan key pool, auth cache ini perlu di-handle hati-hati.

**Strategy:**
1. Key pool always win — kalo provider terdaftar, pake dari key pool.
2. Kalo key pool return null (semua keys dead/cooldown) → fallback `registry.getApiKeyAndHeaders(targetModel)` **LANGSUNG**, bukan `getCachedAuth`. Ini biar gak dapet stale cached auth yang udah expired.
3. Kalo provider gak terdaftar di key pool → pake `getCachedAuth` seperti biasa.

```typescript
// Logic:
if (keyPool?.hasProvider(targetModel.provider)) {
  const keyAuth = keyPool.getNextKey(targetModel.provider)
  if (keyAuth) {
    // Pake dari key pool
    auth = keyAuth
  } else {
    // Semua keys dead/cooldown → fallback langsung ke registry, SKIP cache
    const raw = await registry.getApiKeyAndHeaders(targetModel)
    auth = raw?.ok ? { apiKey: raw.apiKey, headers: raw.headers } : null
  }
} else {
  // Provider gak terdaftar di key pool → pake auth existing
  auth = await getCachedAuth(targetModel, registry)
}
```

### Cooldown Integration (Existing)

Sekarang ada `rate-limit-tracker.ts` yang track model cooldown. Key pool punya **dual-layer cooldown**:

1. **Model cooldown** (existing) — model X kena rate limit → skip X di fallback chain
2. **Key cooldown** (baru) — key Y kena rate limit → pake key Z dari pool yang sama

Keduanya jalan paralel. Model cooldown = model level. Key cooldown = provider/credential level.

### Scope: Global vs Project

Sama kayak `model-router.json` — merge global + project.
- Global: `~/.pi/agent/router-keys.json`
- Project: `.pi/router-keys.json`

Project override global (per-provider). Kalo project punya config buat `openrouter`, pake project. Kalo gak ada, pake global.

---

## Subcommands (`/router keys`)

| Subcommand | Description |
|---|---|
| `/router keys` / `/router keys status` | Tampilkan semua key pools, health per key, active key |
| `/router keys reload` | Reload config dari file |
| `/router keys add <provider>` | Tambah key baru ke provider tertentu |
| `/router keys remove <provider>` | Pilih key yang mau dihapus |
| `/router keys test <provider>` | Test semua keys (coba hit API /models endpoint) |
| `/router keys clearcache` | Reset semua cooldown state |

### Status Display

```
🔑 Key Pools
  openrouter    — 3 keys (2 healthy, 1 cooldown 2m lagi) | round-robin
    [active]  sk-or-v1-aaaa... → usage: 12, last: 2s ago
              sk-or-v1-bbbb... → usage: 8, last: 1m ago (COOLDOWN 2m)
              sk-or-v1-cccc... → usage: 0, never used
  opencode-go   — 1 key (healthy) | fallback
    [active]  sk-xxx...        → usage: 5, last: 30s ago
```

### Footer Status (via `ctx.ui.setStatus`)

Pas model aktif router provider:
```
🔑 OR:3 (2✓ 1⏳) | OG:1✓
```

Arti: OpenRouter 3 keys (2 healthy, 1 cooldown), OpenCode-Go 1 key healthy.

Kalo gak pake router model:
```
🔑 (no keys configured)
```

---

## Phased Implementation

### Phase 1: Foundation (key-pool.ts + keys-config.ts)
- `key-pool.ts` — class + round-robin + fallback + health tracking
- `keys-config.ts` — load/save/normalize
- Types di `types.ts`
- **Single key per provider** works
- Belum integrate ke streamSimple

### Phase 2: Integration (provider.ts + index.ts)
- Mod `provider.ts` — auth lookup lewat key pool
- Mod `index.ts` — key pool lifecycle
- **Testing:** fallback chain dengan key pool aktif
- Verify: no breaking change kalo gak ada `router-keys.json`

### Phase 3: Commands (keys-commands.ts)
- `/router keys` submenu
- Status display
- Add/remove keys
- Footer integration

### Phase 4: Edge Cases & Polish
- Multiple keys + round-robin + concurrent requests
- Key validation (`/router keys test`)
- Error rate tracking (auto-disable key yg sering error)
- Recovery after all keys cooldown

---

## Test Scenarios

| Scenario | Expected |
|---|---|
| Gak ada `router-keys.json` | Fallback ke pi built-in auth. **No error.** |
| 1 provider, 1 key, sehat | Pake key itu, jalan normal |
| 1 provider, 3 keys, round-robin | Key 1 → Key 2 → Key 3 → Key 1 |
| Key 1 kena 429 | Cooldown 5m. Otomatis pake Key 2 |
| Key 1 kena 401 | Mark dead. Skip forever. |
| Semua keys cooldown | `null` → fallback ke pi auth. Tapi kalo pi auth juga gak bisa, stream error |
| Provider gak terdaftar di key pool | Fallback ke `registry.getApiKeyAndHeaders()` |
| Config berubah pas session (reload) | Key pool reload via atomic replacement (bukan mutate in-place). Active requests pegang reference ke pool lama, request baru dapet pool baru. |
| Round-robin + concurrent requests | 2 model pake key berbeda di waktu yang sama |

---

## What's NOT Included (v1)

| Fitur | Alasan |
|---|---|
| **Encrypted key storage** | Kompleksitas. File permission `chmod 600` cukup untuk sekarang |
| **Auto-discovery (scan API buat list models)** | Terlalu berat. Bisa tambah nanti |
| **Cost tracking per key** | Butuh state persistence + API parsing |
| **Key expiry monitoring** | API keys biasanya gak expire. Low value. |
| **Dashboard widget** | Bisa tambah kalo TUI widget diperlukan |
| **OAuth / SSO support** | Key-based only v1. OAuth beda flow. |
| **CLI flags** (`--key-pool-file`) | Bisa tambah nanti |
| **Per-key revive command** | Sementara `dead` punya time-based recovery (1 jam). `/router keys revive <provider>` bisa ditambah nanti kalo dibutuhin |

## Post-Review Changes

Plan ini udah melalui review oleh sub-agent reviewer. Temuan yang di-fix:

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | HIGH | `tryModel()` re-fetches auth independently — key pool auth never reaches API call | Pass `keyAuth` sebagai parameter ke `tryModel()`, ganti `getCachedAuth` di dalamnya |
| 2 | HIGH | `isTransientError` gate blocks auth errors → keys never marked dead | Hapus gate. Always call `markFailed`. Biar method sendiri yang klasifikasi error |
| 3 | HIGH | `markSuccess` never called → health never resets | Panggil `keyPool.markSuccess()` pas `tryModel` return true |
| 4 | HIGH | `.pi/router-keys.json` not gitignored → keys committed to git | Tambah security warning + rekomendasi global scope. Update `.gitignore` |
| 5 | MEDIUM | Dead keys have no recovery path | Tambah time-based recovery: dead keys coba lagi setelah 1 jam |
| 6 | MEDIUM | Header merge strategy unspecified | Document: key pool headers **fully replace** pi built-in headers untuk managed provider |
| 7 | MEDIUM | Stale auth cache when key pool returns null after reload | Fallback langsung ke `registry.getApiKeyAndHeaders()`, bukan `getCachedAuth()` |
| 8 | LOW | Reload race condition underspecified | Atomic replacement: assign new pool instance, gak mutate existing |
| 9 | LOW | `markFailed` assumes `Error` instance | Pake defensive pattern `error instanceof Error ? error.message : String(error)` |

---

## Sumber Referensi

- Diskusi dengan user: session 2026-07-03 (key pool manager)
- Pi extension SDK: `docs/extensions.md`, `docs/custom-provider.md`
- Existing code: `extensions/provider.ts`, `extensions/rate-limit-tracker.ts`
- Existing plan: `docs/plan.md`
