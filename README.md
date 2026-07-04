# pi-model-router

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**pi-model-router** adalah extension untuk [pi coding agent](https://github.com/earendil-works/pi-coding-agent) yang memungkinkan kamu mendefinisikan **custom model groups** dengan **fallback chain**.

Buat logical model kayak `thinker` atau `pekerja` — isinya daftar model real. Setiap turn, extension coba model pertama, kalo gagal otomatis fallback ke berikutnya. Gak perlu mikir ulang milih model tiap kali satu model error.

---

## Instalasi

### 1. Clone / Symlink

Tempatkan project ini di direktori extensions pi. Bisa global (`~/.pi/extensions/`) atau per project (`.pi/extensions/` di root project kamu).

```bash
# Symlink global (tersedia di semua session pi)
ln -s /path/to/pi-model-router ~/.pi/extensions/pi-model-router

# Atau project-local
ln -s /path/to/pi-model-router .pi/extensions/pi-model-router
```

### 2. Install Dependencies

```bash
cd /path/to/pi-model-router
npm install
```

Extension ini membutuhkan peer dependencies dari pi:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`

Pastikan semua sudah terinstall di environment pi kamu.

### 3. Register di Konfigurasi Pi

Tambahin ke `extensions` array di konfigurasi pi kamu:

```json
{
  "extensions": ["pi-model-router"]
}
```

Atau kalo pake path relatif:

```json
{
  "extensions": ["./extensions/pi-model-router"]
}
```

### 4. Restart Pi

Restart session pi. Extension akan otomatis terload. Kamu bakal liat pesan:
```
[router-extension] Loaded. Config models: ...
```

---

## Konfigurasi

### 2-Layer Config

Extension ini support **2-layer config**: global + project-specific.

| Layer | Path | Prioritas |
|---|---|---|
| Global | `~/.pi/agent/model-router.json` | Default (low) |
| Project | `.pi/model-router.json` | Override global (high) |

Keduanya di-**merge** — project config meng-override model definitions dengan key yang sama dari global config. Ini berguna misalnya kamu punya model `thinker` di global, tapi di project tertentu mau pake daftar model yang berbeda.

### Schema

```jsonc
{
  "models": {
    "<nama-custom>": {
      "models": [
        "provider/model-a",   // prioritas tertinggi (dicoba pertama)
        "provider/model-b"    // fallback kalo model-a gagal
      ],
      "thinking": "high"      // optional — override thinking level
    }
  }
}
```

| Field | Tipe | Wajib | Deskripsi |
|---|---|---|---|
| `models` | `object` | ✅ | Key-value logical model definitions |
| `<nama-custom>` | `string` | ✅ | Nama logical model, dipake sebagai `router/<nama>` |
| `models[].models` | `string[]` | ✅ | Array canonical `provider/model` refs, **urutan prioritas fallback** |
| `models[].thinking` | `string \| null` | ❌ | Override thinking level (`"high"`, `"medium"`, `"low"`, `"off"`, dll). Default: inherit dari pi settings |

### Contoh Lengkap

```jsonc
{
  "models": {
    "thinker": {
      "models": [
        "opencode-go/deepseek-v4-pro",
        "mimo-2.5-pro",
        "opencode/deepseek-v4-flash-free"
      ],
      "thinking": "high"
    },
    "pekerja": {
      "models": [
        "openrouter/owl-alpha",
        "opencode/deepseek-v4-flash-free"
      ]
    }
  }
}
```

Dengan config di atas, kamu punya dua logical model: `router/thinker` dan `router/pekerja`.

---

## Key Pool Manager

Pi-model-router dilengkapi **Key Pool Manager** untuk mengelola multiple API keys per provider secara terpusat. Dengan fitur ini, kamu gak perlu lagi nyebar API keys di konfigurasi pi atau bingung kalo satu kena rate limit.

### Cara Kerja

Key Pool Manager menyediakan **centralized API key management**:

- **Multiple keys per provider** — simpan beberapa API key untuk satu provider
- **Key rotation strategies** — pilih cara distribusi keys
- **Health tracking** — cooldown/dead classification otomatis, lazy recovery
- **Live footer status** — pantau status key pool langsung dari status line pi
- **Backward compatible** — kalo gak ada `router-keys.json`, extension jalan normal pake pi built-in auth

### Router-keys.json Schema

Sama kayak config router, key pool juga pake **2-layer config**:

| Layer | Path | Prioritas |
|---|---|---|
| Global | `~/.pi/agent/router-keys.json` | Default (low) |
| Project | `.pi/router-keys.json` | Override global (high) |

Keduanya di-**merge** — project config menambahkan/meng-override provider keys dari global config.

```jsonc
{
  "providers": {
    "openrouter": {
      "keys": ["sk-or-v1-aaaa...", "sk-or-v1-bbbb..."],
      "strategy": "round-robin"
    },
    "anthropic": {
      "keys": ["sk-ant-xxxx..."],
      "headers": {
        "X-Title": "pi"
      }
    }
  }
}
```

| Field | Tipe | Wajib | Deskripsi |
|---|---|---|---|
| `providers` | `object` | ✅ | Key-value provider definitions |
| `<provider>.keys` | `string[]` | ✅ | Array API keys untuk provider tersebut |
| `<provider>.strategy` | `string` | ❌ | Key rotation strategy: `"round-robin"` (default) atau `"fallback"` |
| `<provider>.headers` | `object` | ❌ | Custom headers yang ditambahkan ke request provider (opsional) |

### Key Rotation Strategies

| Strategy | Deskripsi |
|---|---|
| **round-robin** (default) | Distribusi keys secara bergiliran — ideal untuk load balancing. Tiap request pake key berikutnya secara siklik. |
| **fallback** | Coba key pertama yang sehat — ideal untuk redundancy. Kalo key pertama error, pake key berikutnya. |

### Health Classification

Key Pool Manager otomatis mengklasifikasikan health tiap key berdasarkan response dari provider:

| Kode | Klasifikasi | Cooldown | Deskripsi |
|---|---|---|---|
| 429 (Rate Limit) | ⏳ **cooldown** | 60 detik | Too many requests — jeda sementara |
| 5xx (Server Error) | ⏳ **cooldown** | 60 detik | Error dari server — jeda sementara |
| 401/403 (Auth) | ❌ **dead** | 300 detik | Auth failed — key mungkin expired/revoked |
| 5 consecutive errors | ❌ **dead** | 300 detik | Error rate threshold — key dinonaktifkan |
| ✅ Success | ✅ **healthy** | — | Reset semua health metrics |

Setelah cooldown/dead expires, key otomatis direcovery secara **lazy** — dicoba kembali di request berikutnya.

### Footer Status

Di status line pi, kamu bakal liat live summary key pool:

```
🔑 OR:3 (2✓ 1⏳)
```

Artinya: provider `openrouter` punya 3 keys, 2 sehat (✓), 1 dalam cooldown (⏳).

### Backward Compatibility

Kalo `router-keys.json` gak ada di kedua layer (global + project), Key Pool Manager gak aktif — extension pake mekanisme auth pi built-in kayak biasanya. Gak perlu migrasi config.

---

## Usage

Di pi, tinggal pilih model dengan prefix `router/`:

```
# Pilih logical model "thinker"
router/thinker

# Pilih logical model "pekerja"
router/pekerja
```

### Flow Eksekusi

```
Kamu pilih "router/thinker"
                │
                ▼
      ┌─────────────────┐
      │ Coba model #1    │ ← opencode-go/deepseek-v4-pro
      │   deepseek-v4-pro│
      └────────┬────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
   Sukses?              Gagal?
     │                    │
     ▼                    ▼
  Selesai       ┌─────────────────┐
                │ Coba model #2    │ ← mimo-2.5-pro (fallback)
                │   mimo-2.5-pro  │
                └────────┬────────┘
                         │
               ┌─────────┴──────────┐
               ▼                    ▼
             Sukses?              Gagal?
               │                    │
               ▼                    ▼
            Selesai       ┌─────────────────────┐
                          │ Coba model #3        │ ← deepseek-v4-flash-free
                          │   deepseek-v4-flash  │
                          └──────────┬──────────┘
                                     │
                           ┌─────────┴──────────┐
                           ▼                    ▼
                         Sukses?              Gagal?
                           │                    │
                           ▼                    ▼
                        Selesai       Error: semua gagal
```

Setiap kali terjadi fallback, kamu bakal dapet notifikasi di output:

```
⚠️ opencode-go/deepseek-v4-pro gagal, fallback ke mimo-2.5-pro
```

### Graceful Thinking Degrade

Kalo model pertama support `thinking: "high"` tapi model kedua cuma support `thinking: "medium"`, extension otomatis **downscale** thinking level ke level maksimal yang didukung model — tanpa error.

### Image Detection & Filtering

Kalo context mengandung gambar, extension otomatis **memfilter** candidate models — cuma model yang punya `image` support yang bakal dicoba. Model yang cuma text otomatis di-skip. Deteksi dilakukan dari `modelRegistry`, bukan dari config.

---

## Commands

Extension ini registered command `/router` dengan beberapa subcommand:

| Command | Deskripsi |
|---|---|
| `/router status` | Tampilkan config aktif, daftar model definitions, dan thinking levels |
| `/router reload` | Reload config dari file (tanpa restart pi) |
| `/router help` | Bantuan — daftar subcommand yang tersedia |
| `/router keys` | Submenu manajemen key pool — daftar subcommand keys |
| `/router keys status` | Status key pool per provider (health, strategy, cooldown) |
| `/router keys reload` | Reload `router-keys.json` dari file |
| `/router keys add <provider>` | Tambah API key baru secara interaktif untuk provider |
| `/router keys remove <provider>` | Hapus API key secara interaktif dari provider |
| `/router keys clearcache` | Reset semua cooldown/dead state di memory |
| `/router keys test <provider>` | Validasi semua keys provider via real API call |

### Contoh Output

```
/router status
🔀 Router Status
Models: thinker, pekerja
  thinker: opencode-go/deepseek-v4-pro → mimo-2.5-pro → opencode/deepseek-v4-flash-free [thinking: high]
  pekerja: openrouter/owl-alpha → opencode/deepseek-v4-flash-free
```

---

## Fitur

| Fitur | Deskripsi |
|---|---|
| **Fallback Chain** | Coba model berikutnya otomatis kalo model sebelumnya gagal. Urutan sesuai config. |
| **Graceful Thinking Degrade** | Kalo model gak support thinking level yang diminta, otomatis downscale ke level maksimal model. Gak perlu config manual. |
| **Image Detection** | Filter model berdasarkan image support — detect otomatis dari `modelRegistry`, bukan dari config. |
| **Context Truncation** | Otomatis truncate context (buang pesan tertua) kalo melebihi context window model target. |
| **Re-registration Guard** | Fingerprint model definitions pake JSON hash. Skip re-register kalo config gak berubah — hemat resource. |
| **Fallback Notification** | Notifikasi di output tiap kali terjadi fallback, jelas dari model mana ke mana. |
| **2-Layer Config** | Global (`~/.pi/agent/`) + project (`.pi/`) — project override global. Cocok buat workspace-specific config. |
| **Auto-completion** | `/router` command punya autocomplete untuk semua subcommands — termasuk `/router keys`. |
| **Key Pool Manager** | Centralized API key management dengan multiple keys per provider, health tracking, dan lazy recovery. |
| **Key Rotation** | Round-robin + fallback strategy otomatis. Distribusi keys sesuai strategi yang dipilih. |
| **Health Tracking** | Cooldown/dead classification, error rate threshold (5 consecutive errors → dead), lazy recovery otomatis. |
| **Key Management Commands** | `/router keys` submenu — add, remove, reload, test, clearcache. |
| **Footer Status** | Live key pool summary di status line pi (`🔑 OR:3 (2✓ 1⏳)`). |

---

## Development

### Struktur Project

```
extensions/
├── index.ts              → Entry point, orchestrator, hooks, closure state
├── provider.ts           → registerProvider + streamSimple loop (fallback chain)
├── config.ts             → Load, parse, merge, normalize config + helpers
├── commands.ts           → /router subcommands (status, reload, help)
├── key-pool.ts           → ModelKeyPool class (rotation, health tracking, error classification)
├── keys-config.ts        → Config loader untuk router-keys.json (load, merge, normalizeKeysConfig)
├── keys-commands.ts      → /router keys command handlers (status, reload, add, remove, clearcache, test)
├── ui.ts                 → Status line helpers
├── types.ts              → TypeScript interfaces (RouterConfig, CustomModelConfig, KeyPoolConfig)
├── constants.ts          → Default values (context window, max tokens, filename)
├── config.test.ts        → Unit tests untuk config module (50+ test cases)
├── provider.test.ts      → Unit tests untuk provider module
├── key-pool.test.ts      → Unit tests untuk key pool (rotation strategy, health tracking, error classification, recovery)
├── keys-config.test.ts   → Unit tests untuk keys config (normalizeKeysConfig validation, loadKeysConfig merge)
└── keys-commands.test.ts → Unit tests untuk key commands (command parsing, status display, add/remove/clearcache/test)
```

### Scripts

```bash
npm test            # Run semua unit tests (Vitest)
npm run typecheck   # TypeScript strict type checking (tsc --noEmit)
npm run test:watch  # Run tests in watch mode
```

### Testing

Unit tests menggunakan [Vitest](https://vitest.dev/). Coverage meliputi:

- **config.test.ts** — normalisasi config, validasi error, `getMaxThinkingLevel`, `contextHasImage`, `resolveModelRef`
- **provider.test.ts** — fallback chain logic, thinking degrade, image filtering, auth checking, error handling
- **key-pool.test.ts** — key rotation strategy (round-robin, fallback), health tracking (cooldown, dead classification), error rate threshold (5 consecutive → dead), lazy recovery, markSuccess reset
- **keys-config.test.ts** — `normalizeKeysConfig` validation (missing fields, invalid strategy), `loadKeysConfig` merge (global + project layer), backward compatibility (tidak ada file = return null)
- **keys-commands.test.ts** — command parsing, status display formatting, add/remove/clearcache/test flow

Jalankan dengan:

```bash
npm test
```

---

## Catatan Teknis

- **Provider name** hardcode sebagai `"router"` — gampang diubah kalo suatu saat perlu multiple router provider.
- **Cooldown/dead state** adalah **in-memory** — akan reset tiap kali pi di-restart. Command `/router keys clearcache` bisa dipake untuk reset manual tanpa restart.
- **Cost tracking** tidak diimplementasikan — ini bukan budget router.
- Extension ini adalah **versi sederhana** dari [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router) — tanpa heuristic routing, LLM classifier, cost budget, atau state persistence.

### Yang Tidak Ada di V1

| Fitur | Alasan |
|---|---|
| Heuristic routing (keyword/word-count/phase-bias) | Overkill untuk use case custom grouping |
| LLM classifier routing | Kompleksitas tinggi, perlu fast model + prompt |
| Cost budget / accumulated cost tracking | Ditangani oleh key-level health tracking — budget routing tidak diimplementasi |
| Phase bias / stickiness | Overengineering untuk v1 |
| Persistent key state (across restart) | Cooldown/dead cukup in-memory — gak perlu file state tambahan |
| Widget TUI | Cukup status line + commands |

---

## Lisensi

MIT License. Berdasarkan [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router) (versi sederhana).

Copyright (c) 2026
