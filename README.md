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
| **Dynamic Context Window Update** | CTW footer otomatis berubah sesuai model aktif — presisi context window tanpa restart. |
| **Cost & Usage Tracking** | Catat biaya dan token per request ke SQLite. Lihat aggregate via `/router cost`. |
| **Cooldown Escalation** | Error berulang pada model yang sama meningkatkan durasi cooldown (5m → 1h → 6h). |
| **Re-registration Guard** | Fingerprint model definitions pake JSON hash. Skip re-register kalo config gak berubah — hemat resource. |
| **Fallback Notification** | Notifikasi di output tiap kali terjadi fallback, jelas dari model mana ke mana. |
| **2-Layer Config** | Global (`~/.pi/agent/`) + project (`.pi/`) — project override global. Cocok buat workspace-specific config. |
| **Auto-completion** | `/router` command punya autocomplete untuk semua subcommands. |

---

## Development

### Struktur Project

```
extensions/
├── index.ts        → Entry point, orchestrator, hooks, closure state
├── provider.ts     → registerProvider + streamSimple loop (fallback chain)
├── config.ts       → Load, parse, merge, normalize config + helpers
├── commands.ts     → /router subcommands (status, reload, help)
├── ui.ts           → Status line helpers
├── types.ts        → TypeScript interfaces (RouterConfig, CustomModelConfig)
├── constants.ts    → Default values (context window, max tokens, filename)
├── config.test.ts  → Unit tests untuk config module (50+ test cases)
└── provider.test.ts → Unit tests untuk provider module
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

Jalankan dengan:

```bash
npm test
```

---

## Catatan Teknis

- **Provider name** hardcode sebagai `"router"` — gampang diubah kalo suatu saat perlu multiple router provider.
- **State persistence** sengaja di-skip di v1 — semua stateless, config dari file doang.
- **Cost tracking** tidak diimplementasikan — ini bukan budget router.
- Extension ini adalah **versi sederhana** dari [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router) — tanpa heuristic routing, LLM classifier, cost budget, atau state persistence.

### Yang Tidak Ada di V1

| Fitur | Alasan |
|---|---|
| Heuristic routing (keyword/word-count/phase-bias) | Overkill untuk use case custom grouping |
| LLM classifier routing | Kompleksitas tinggi, perlu fast model + prompt |
| Cost budget / accumulated cost tracking | **Supported** via `/router cost` + auto footer — SQLite persistent |
| Phase bias / stickiness | Overengineering untuk v1 |
| State persistence (pin/unpin) | Config file cukup |
| Widget TUI | Cukup status line |

---

## Lisensi

MIT License. Berdasarkan [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router) (versi sederhana).

Copyright (c) 2026
