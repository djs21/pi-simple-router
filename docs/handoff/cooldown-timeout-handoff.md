# Handoff: pi-simple-router — Cooldown & Timeout Fixes

## Status

3 commits past `router-model-scope-handoff.md`, pushed to `master`:
- `2418a6b` — auth cache, abort signal checks, thinking default fix, findModel smart lookup
- `f6d8229` — allCooldown bug, provider-level cooldown, remaining time display

## What Was Done

### Commit `2418a6b` — Timeout & Model Resolution Improvements

| Change | Details |
|---|---|
| **`findModel()` smart lookup** | `registry.find()` fallback: jika `provider + modelId` gagal, coba `provider + provider/modelId`. Fixes refs like `openrouter/owl-alpha` where OpenRouter's registered model ID is `openrouter/owl-alpha` (with upstream prefix). |
| **Auth cache** (`getCachedAuth()`) | `Map<provider/modelId, { apiKey, headers }>` — satu call `getApiKeyAndHeaders` per model per session, bukan per kandidat fallback. Reduces overhead in fallback chain. |
| **Abort signal checks** | `checkAborted()` setelah tiap `await`. `RouterAbortError` extends Error — caught di fallback loop, stop chain early tanpa cooldown model. |
| **Stream-vs-signal race** | `Promise.race` antara stream events dan `AbortSignal` — deteksi abort real-time. |
| **Thinking: default fix** | `thinking: "default"` dulu dikirim sebagai invalid `reasoning` param (`{ max_tokens: 0 }`) → provider reject/hang. Now falls through to `effectiveThinking = undefined` (inherit dari pi). |

### Commit `f6d8229` — Cooldown Improvements

| Change | Details |
|---|---|
| **allCooldown bug fix** | Boolean flag `allCooldown` dihapus. Diganti `candidates.every(ref ⇒ isRateLimited(ref))` di akhir loop. Ini fix misleading message ketika kandidat pertama gagal transient (set `allCooldown = false`) lalu kandidat terakhir ternyata cooldown. |
| **Provider-level cooldown** | Error pattern 502/503/504/service unavailable/bad gateway/gateway timeout/overloaded trigger cooldown key `__provider:<name>`. Semua model dari provider itu di-skip sampai cooldown expire. |
| **Remaining time display** | Skip messages now show `"⏳ model cooldown (sisa 3m 24s), skip ke next"`. Uses `getRemainingCooldownMs()` + `formatDuration()`. |

### Root Causes Identified

**Timeout issue** (reported: router models timeout but same models work direct):
1. `thinking: "default"` → invalid reasoning param → provider timeout/hang
2. No auth cache → `getApiKeyAndHeaders` dipanggil per candidate → ~100ms overhead × N candidates
3. No abort signal checking → pi bisa cancel sebelum streamSimple starts, tapi router gak ngecek

**Model availability issue** (reported: router model skip tapi model OK langsung):
4. `openrouter/owl-alpha` → `resolveModelRef` parses `modelId = "owl-alpha"` → `registry.find` fails → skip silently. Fix: `findModel()` fallback tries `"openrouter/owl-alpha"`.

## Current Config

**Global** (`~/.pi/agent/model-router.json`):
```json
{
  "models": {
    "orc":        { "models": ["claudinio2/claudinio","opencode-go/deepseek-v4-flash","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro"] },
    "worker":     { "models": ["opencode/deepseek-v4-flash-free","opencode/mimo-v2.5-free","claudinio2/claudinio","openrouter/openrouter/owl-alpha","deepseek/deepseek-v4-flash"] },
    "reviewer":   { "models": ["claudinio2/claudinio","opencode-go/deepseek-v4-pro","deepseek/deepseek-v4-pro"], "thinking": "high" }
  }
}
```

**Project** (`.pi/model-router.json`):
```json
{ "models": { "worker": { "models": ["opencode/deepseek-v4-flash-free","openrouter/owl-alpha","openrouter/google/gemma-4-31b-it:free"] } } }
```

Catatan: `openrouter/owl-alpha` di project config sekarang **beres** karena `findModel()` fallback handle lookup.

## Current State

- 50/50 Vitest tests passing (pre-existing TS error at `provider.test.ts:20` is cosmetic — `Symbol.asyncIterator` mock issue)
- `rateLimitCooldownMs` default: 300000 (5 menit)
- Manual reset: `/router clearcache` (via commands.ts — clears auth cache + rate limits)
- Cooldown **tidak** persist antar sesi pi (in-memory `Map`)

## Remaining Concerns / Not Yet Addressed

1. **Flat 5 min cooldown duration** — semua transient error kena durasi sama. Tidak ada bedanya rate limit 429 (bisa pulih detik) vs 503 (bisa menit). Tidak ada parsing `Retry-After` header.
2. **False positive in `isTransientError`** — pattern `"backend"`, `"upstream"`, `"temporarily"` terlalu broad. Error seperti `"backend configuration invalid"` masuk transient → cooldown 5 menit. Risiko rendah karena error message dari provider cukup predictable.
3. **Exponential backoff** — model yang konsisten gagal terus kena 5 menit flat setiap kali, bukan durasi meningkat seperti retry^1.5.
4. **No persistent cooldown** — restart pi → semua cooldown hilang. Risk: user yang sering restart pi gak dapet manfaat cooldown.

## File Architecture (Relevant to This Session)

```
extensions/
├── provider.ts            ← All timeout fixes, cooldown logic, findModel helper, auth cache, abort checks
├── rate-limit-tracker.ts  ← isTransientError, isRateLimitError, isRateLimited, markRateLimited, getRemainingCooldownMs
├── commands.ts            ← `/router` menu (includes `/router clearcache`)
├── index.ts               ← Entry point, eager registration + session_start hook
├── constants.ts           ← DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300000
```

## Feature Flag to Watch

Hasil eksperimen dari diskusi: invalid `reasoning` param (`thinking: "default"`) menyebabkan provider-dependent behavior (timeout, reject, or hang). Fix sudah applied di `computeEffectiveThinking()` — unknown values fall through ke `undefined`.

## Suggested Skills

- **`diagnose`**: If timeout/failures persist despite fixes — use telemetry-first approach (abort signal timing, auth cache hits, cooldown state per ref)
- **`handoff`**: Konfigurasi tidak berubah (global + project). Refer `router-model-scope-handoff.md` untuk scope selector docs.
- **`prototype`**: Sebelum implement exponential backoff atau `Retry-After` parsing — bisa prototype dulu buat validasi approach.
- **`tdd`**: Any further fixes should add/update Vitest tests (50 existing tests in `*.test.ts`).

## Key Personas

Sama seperti handoff sebelumnya — **djs**: Indonesian speaker, concise, hates overengineering, calls assistant "bro/gue". Uses cmux/herdr/pi/openrouter. Subagent orchestration pattern.

## Relevant Artifacts

- **Scope handoff**: `docs/handoff/router-model-scope-handoff.md` (base knowledge: scope selector, config merge, interactive menu)
- **Plan**: `docs/plan.md`
- **Example config**: `model-router.example.json`
- **Recent commits**: `f6d8229` (cooldown), `2418a6b` (timeout + findModel), `1e6c22a` (JSON.stringify fix)
- **Global config**: `~/.pi/agent/model-router.json`
- **Project config**: `.pi/model-router.json`
