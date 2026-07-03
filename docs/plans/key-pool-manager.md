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
| `providers[].headers` | No | `{}` | Custom headers buat provider itu (kayak HTTP-Referer buat OpenRouter) |

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
Di `routeStream`, ganti auth lookup:
```typescript
// OLD:
const auth = await getCachedAuth(targetModel, registry);

// NEW:
const keyAuth = keyPool?.getNextKey(targetModel.provider);
const auth = keyAuth ?? await getCachedAuth(targetModel, registry);
```

Kalo key pool gak punya provider itu → fallback ke pi built-in auth = **no breaking change**.

Pas key gagal (di catch block):
```typescript
if (keyAuth && isTransientError(err)) {
  keyPool.markFailed(targetModel.provider, keyAuth.apiKey, err);
}
```

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
markFailed(provider: string, apiKey: string, error: Error): void {
  const pool = this.pools.get(provider)
  if (!pool) return

  const health = pool.health.get(apiKey) ?? { status: 'healthy', failures: 0, usageCount: 0 }
  health.failures++

  if (isRateLimitError(error)) {
    // Rate limit → cooldown 5 menit
    health.status = 'cooldown'
    health.until = Date.now() + rateLimitCooldownMs
  } else if (isAuthError(error)) {
    // 401/403 → mark dead (gak bakal dipake lagi)
    health.status = 'dead'
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

### Lazy Health Recovery

Key yang cooldown otomatis balik `healthy` pas `until` lewat. Di `getNextKey`, filter cek `until`:

```typescript
const isHealthy = (key: string): boolean => {
  const h = pool.health.get(key)
  if (!h) return true
  if (h.status === 'dead') return false
  if (h.status === 'cooldown' && h.until && Date.now() >= h.until) {
    // Cooldown expired → balikin ke healthy
    h.status = 'healthy'
    h.until = undefined
    return true
  }
  return h.status === 'healthy'
}
```

---

## Integration Points

### Auth Cache (Existing)

Sekarang `provider.ts` punya `authCache` — Map of provider/model → apiKey+headers.

Dengan key pool, auth cache ini **bisa di-skip** kalo provider terdaftar di key pool. Tapi kalo provider gak terdaftar, auth cache masih berguna buat pi built-in auth.

**Strategy:** Key pool always win. Kalo key pool punya entry buat provider itu, pake dari key pool. Kalo gak ada, fallback ke auth cache / registry.

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
| Config berubah pas session (reload) | Key pool reload. Active requests pake old pool (no race). |
| Round-robin + concurrent requests | 2 model pake key berbeda di waktu yang sama |

---

## What's NOT Included (v1)

| Fitur | Alasan |
|---|---|
| **Encrypted key storage** | Kompleksitas. File permission cukup untuk sekarang |
| **Auto-discovery (scan API buat list models)** | Terlalu berat. Bisa tambah nanti |
| **Cost tracking per key** | Butuh state persistence + API parsing |
| **Key expiry monitoring** | API keys biasanya gak expire. Low value. |
| **Dashboard widget** | Bisa tambah kalo TUI widget diperlukan |
| **OAuth / SSO support** | Key-based only v1. OAuth beda flow. |
| **CLI flags** (`--key-pool-file`) | Bisa tambah nanti |

---

## Sumber Referensi

- Diskusi dengan user: session 2026-07-03 (key pool manager)
- Pi extension SDK: `docs/extensions.md`, `docs/custom-provider.md`
- Existing code: `extensions/provider.ts`, `extensions/rate-limit-tracker.ts`
- Existing plan: `docs/plan.md`
