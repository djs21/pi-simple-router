# PRD: Key Pool Manager — Centralized API Key Management with Rotation

## Problem Statement

Pengguna pi-simple-router saat ini mengelola API keys secara tersebar: ada di env var, `~/.pi/agent/models.json`, atau pi built-in auth. Setiap provider cuma punya satu key — kalau kena rate limit, user harus手动 ganti key. Tidak ada visibilitas soal health setiap key: mana yang sehat, sedang cooldown, atau expired.

Router extension sudah bisa fallback antar model, tapi belum bisa manage credentials secara terpusat. User masih bergantung pada pi built-in auth system yang scattered.

## Solution

Tambahkan **Key Pool Manager** ke pi-simple-router extension. Satu file konfigurasi (`router-keys.json`) sebagai source of truth untuk semua API keys, dengan dukungan:

- **Multiple keys per provider** — misal 3 key OpenRouter untuk rolling
- **Key rotation strategy** — round-robin (giliran) atau fallback (prioritas)
- **Health tracking** — tahu key mana sehat, cooldown, atau dead
- **Auto-rotate on error** — kena rate limit, otomatis pake key berikutnya
- **Time-based recovery** — key cooldown pulih otomatis, key dead dicoba lagi setelah 1 jam
- **Backward compatible** — tanpa file konfigurasi, extension behave seperti sekarang

## User Stories

1. As a pi-simple-router user, I want to store all my API keys in one file, so that I don't have to scatter them across env vars and config files.
2. As a power user, I want to configure multiple API keys per provider (e.g., 3 OpenRouter keys), so that I can rotate around rate limits.
3. As a user, I want keys to be automatically rotated in round-robin fashion, so that usage is distributed evenly across keys.
4. As a user, I want a "fallback" rotation strategy where key #1 is used until it fails, then key #2, so that I can have primary/backup keys.
5. As a user, I want rate-limited keys to automatically go on cooldown (not used for 5 minutes), so that I don't keep hitting 429 errors.
6. As a user, I want invalid keys (401/403) to be marked as "dead" and retried after 1 hour, so that transient auth failures don't permanently lock out a key.
7. As a user, I want server errors (5xx) to trigger a short cooldown (1 minute), so that transient server issues don't exhaust all keys.
8. As a user, I want to see the status of all key pools — which keys are healthy, cooldown, or dead — so that I can monitor key health.
9. As a user, I want to see key pool status in the pi footer, so that I can monitor without running a command.
10. As a user, I want to reload key configuration without restarting pi, so that I can add/remove keys on-the-fly.
11. As a user, I want to add new keys via `/router keys add <provider>`, so that I don't have to edit JSON files manually.
12. As a user, I want to remove keys via `/router keys remove <provider>` with a selector, so that I can manage keys interactively.
13. As a user, I want to test all keys for a provider (hit provider's API), so that I can validate keys before using them.
14. As a user, I want to reset all cooldown/dead state via `/router keys clearcache`, so that I can recover from edge cases.
15. As a user, I want my extension to fall back to pi's built-in auth when a provider isn't in my key pool config, so that existing providers continue to work without migration.
16. As a user, I want project-scoped key config (`.pi/router-keys.json`) merged with global-scoped config (`~/.pi/agent/router-keys.json`), so that I can have per-project overrides.
17. As a developer, I want the key pool module to be independently unit-testable, so that rotation logic and health tracking are reliable.

## Implementation Decisions

### Module Architecture

- **New module: key-pool.ts** — `ModelKeyPool` class with `getNextKey`, `markFailed`, `markSuccess`, `getStatus`, `reload`, `clear`
- **New module: keys-config.ts** — Load, merge, normalize `router-keys.json` (global + project scoped)
- **New module: keys-commands.ts** — `/router keys` submenu handlers
- **Modified: provider.ts** — Auth lookup DI DALAM `tryModel()`, bukan di `routeStream`. Key pool auth di-pass sebagai parameter ke `tryModel` untuk menghindari re-fetch auth di dalam.
- **Modified: index.ts** — Key pool lifecycle: init di `session_start`, cleanup di `session_shutdown`
- **Modified: types.ts** — Adding `KeyPoolConfig`, `ProviderKeyConfig`, `KeyHealth`, `KeyPoolStatus` interfaces

### Key Rotation Strategies

Two strategies, both scoped to healthy (non-cooldown, non-dead) keys:

- **`round-robin`** (default): Distribute requests evenly. Index counter advances across healthy keys.
- **`fallback`**: Try keys in order, skip unhealthy ones, return first healthy.

Both strategies use `isHealthy` filter that auto-recovers expired cooldowns and expired dead timers.

### Error Classification in markFailed

Errors are classified without an external `isTransientError` gate — `markFailed` is ALWAYS called when key pool auth is active, and it classifies internally:

| Error | Status | Duration |
|---|---|---|
| Rate limit (429 / "rate limit") | `cooldown` | 5 minutes |
| Auth error (401 / 403 / unauthorized / invalid api key) | `dead` | 1 hour (then retry) |
| Server error (502 / 503 / 504) | `cooldown` | 1 minute |
| Other errors | `cooldown` | 30 seconds |

Defensive pattern: `const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()`

### Health Recovery

- `cooldown` keys auto-recover to `healthy` when `Date.now() >= health.until`
- `dead` keys auto-recover to `healthy` after 1 hour (`until` timestamp)
- Recovery is lazy — happens inside `isHealthy()` filter during `getNextKey`, no background timer needed

### Auth Cache Strategy

When a provider IS in the key pool:
- Key pool returns auth → use it (bypass built-in auth cache entirely)
- Key pool returns null (all keys dead/cooldown) → fallback to `registry.getApiKeyAndHeaders(targetModel)` **directly** (not `getCachedAuth` — avoid stale cached credentials)

When a provider is NOT in the key pool → use existing `getCachedAuth` flow as before.

### Config File Scope

Merge pattern mirip `model-router.json`:
- Global: `~/.pi/agent/router-keys.json` — rekomendasi utama untuk key storage
- Project: `.pi/router-keys.json` — override per-project
- Project override global per-provider (bukan deep merge per field)

### Header Handling

Key pool headers (dari `router-keys.json[providers][].headers`) **fully replace** pi built-in headers untuk provider yang dikelola key pool. Tidak ada deep merge — user sudah explicit configure di key pool file.

### Security

- `.pi/router-keys.json` harus di `.gitignore` — jangan sampai API keys ter-commit
- Rekomendasi: simpan keys di global scope (`~/.pi/agent/`) karena di luar repo
- File permission: `chmod 600`

### Atomic Reload

`reload(config)` membuat `ModelKeyPool` instance baru, bukan mutasi in-place. Active requests memegang reference ke pool lama, request baru dapat pool baru. Tidak ada race condition.

## Testing Decisions

### What Makes a Good Test

- Test external behavior, not implementation details
- Test rotation output (which key is returned), not internal index counter
- Test health transitions (healthy → cooldown → healthy), not internal timer
- Mock at pi SDK boundary (`streamSimple`, `registry.getApiKeyAndHeaders`), not at key pool internal

### Modules to Test

| Module | Test File | Approach |
|---|---|---|
| `key-pool.ts` (NEW) | `key-pool.test.ts` | Pure class test. Instantiate `ModelKeyPool`, call methods, assert key selection and health states. Zero mocks needed. |
| `keys-config.ts` (NEW) | `keys-config.test.ts` | Load/normalize/merge config. Mock `fs.readFileSync`. Test validation + merge behavior. |
| `provider.ts` (EXISTING) | `provider.test.ts` (additions) | Test `registerRouterProvider` with mocked key pool. Verify: (a) key pool auth passed to `streamSimple`, (b) fallback to registry when key pool null, (c) `markFailed` called on error. |
| `index.ts` (EXISTING) | `index.test.ts` (NEW) | Test lifecycle hooks: init, cleanup. |

### Prior Art

- `provider.test.ts` — Vitest with `vi.mock` for pi SDK modules. Tests `registerRouterProvider` with mocked `streamSimple`, verifies event stream output and fallback behavior.
- `config.test.ts` — Tests loading from multiple scopes, merge, validation. Uses `vi.mock` for `fs`.

Follow the same structure: `describe/expect` blocks, `vi.fn()` for mocks, `beforeEach` for reset.

## Out of Scope

- **Encrypted key storage** — File permission (`chmod 600`) cukup untuk v1
- **Auto-discovery of models via API** — Bisa ditambah nanti
- **Cost tracking per key** — Butuh state persistence + API response parsing
- **Key expiry monitoring** — API keys jarang expire. Low value.
- **Dashboard widget (TUI)** — Cukup status bar untuk sekarang
- **OAuth / SSO support** — Key-based only v1
- **CLI flags** (`--key-pool-file`) — Bisa ditambah nanti
- **Per-key revive command** — Sementara `dead` punya time-based recovery. `/router keys revive <provider>` bisa nanti jika diperlukan
- **Concurrent request locking** — JavaScript single-threaded event loop membuat `getNextKey` atomic. Map operations tidak perlu lock.

## Further Notes

- Plan detail: `docs/plans/key-pool-manager.md`
- Review findings: plan sudah melalui review sub-agent dengan 9 findings (semua resolved)
- Implementation ada di branch `router-manager`
- Testing seams sudah diverifikasi dengan user
