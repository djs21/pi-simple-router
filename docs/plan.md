# Plan: Custom Model Router Extension

## Purpose

Buat extension pi yang memungkinkan user mendefinisikan **custom model groups** dengan **fallback chain**. User bikin logical model (misal "thinker") yang isinya list model real — setiap turn, extension coba model pertama, kalo gagal fallback ke berikutnya.

Versi sederhana dari [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router) — tanpa heuristic routing, LLM classifier, cost budget, atau state persistence.

---

## Design Decisions (post-review)

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Provider name | **Hardcode `"router"`** | Simplify v1. Gampang diubah nanti |
| Thinking schema | **Single level** (`"high"` atau `null`) | `{prefer, min}` object overdesigned untuk v1 |
| Image support | **Detect otomatis dari modelRegistry** | Config field redundant dan gampang stale |
| State persistence | **Skip v1** | Semua stateless. Config file only |
| Pin commands | **Drop v1** | Butuh persistence, kontradiksi sama stateless |
| `streamSimple` | **Pakai `model.id`** | Signature asli pi SDK: `streamSimple(model, context, options?)` |

---

## Config Schema

**File:** `.pi/model-router.json` (project-level) + `~/.pi/agent/model-router.json` (global, merge)

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

- `models` — object key = logical model name (digunakan sebagai `router/<name>`)
- `models[].models` — array of canonical `provider/model` refs, **urutan prioritas fallback**
- `models[].thinking` — optional. Thinking level override. Default: inherit dari pi settings. Graceful degrade kalo model ga support level yg diminta.

---

## Architecture

```
extensions/
├── index.ts        → Entry point, orchestrator, closure state
├── provider.ts     → pi.registerProvider('router', ...) + streamSimple loop
├── config.ts       → Load, parse, merge, normalize config
├── commands.ts     → /router status, config, reload
├── ui.ts           → Status line rendering
├── types.ts        → TypeScript interfaces
└── constants.ts    → Default values
```

### Module Responsibilities

#### `index.ts`
- Default export `routerExtension(api: ExtensionAPI)`
- Hook `session_start` — load config
- Hook `model_select` — nothing (stateless)
- Manage mutable closure state (config cache, active model info)
- Expose getter/setter objects for sub-modules
- **Re-registration guard** — fingerprint model definitions, skip kalo sama

#### `provider.ts`
- `pi.registerProvider('router', { baseUrl, apiKey, api, models, streamSimple })`
- **Model capability reporting:** report **max** `contextWindow`, `maxTokens` across all fallback models. `reasoning: true` if any fallback supports it. `input: ["text", "image"]` if any supports images. `thinkingLevelMap` sebagai union.
- Core delegation with fallback (lihat flow di bawah)

#### `config.ts`
- `loadRouterConfig()` — baca global `~/.pi/agent/model-router.json` + project `.pi/model-router.json`, merge
- `normalizeConfig(raw)` — validasi + normalize
- `resolveModelRef(ref)` — canonical `provider/model` → lookup dari modelRegistry
- `getMaxThinkingLevel(model)` — cari thinking tertinggi yg didukung model via `model.reasoning` + `model.thinkingLevelMap`

#### `commands.ts`
- Daftarin `/router` command via `pi.registerCommand`
- Subcommands (lihat bawah)

#### `ui.ts`
- `setStatusLine(ctx, text)` — update status bar
- `formatFallbackNotification(prevModel, nextModel)` — formatting

---

## Fallback Chain Logic (Core)

```typescript
async function* streamSimple(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  // 1. Parse custom model name
  const customModelName = model.id;  // e.g., "thinker" dari "router/thinker"

  // 2. Lookup config
  const customModelConfig = config.models[customModelName];
  const modelRefs = customModelConfig.models; // ["provider1/model1", "provider2/model2"]

  // 3. Filter image support jika context contains images
  const targetModels = contextHasImage(context)
    ? modelRefs.filter(ref => modelSupportsImage(ref))
    : modelRefs;

  // 4. Determine target thinking level
  const targetThinking = customModelConfig.thinking ?? currentThinkingLevel;

  // 5. Try each model in order
  for (const [i, ref] of targetModels.entries()) {
    // a. Lookup model dari modelRegistry
    const targetModel = modelRegistry.find(ref);
    if (!targetModel) continue;

    // b. Auth check
    const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
    if (!auth.ok || !auth.apiKey) continue;

    // c. Thinking cap
    const maxLevel = getMaxThinkingLevel(targetModel);
    const effectiveThinking = min(targetThinking, maxLevel); // graceful degrade

    // d. Context truncation jika perlu
    const truncatedCtx = targetModel.contextWindow < context.messages.length
      ? truncateContext(context, targetModel.contextWindow)
      : context;

    // e. Try delegation
    try {
      yield* streamSimple(targetModel, truncatedCtx, {
        ...options,
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: effectiveThinking
      });
      return; // success!
    } catch (err) {
      // Notify fallback
      if (i < targetModels.length - 1) {
        yield { type: 'text', text: `\n[Fallback: ${ref} gagal, lanjut ke ${targetModels[i+1]}]\n` };
      }
    }
  }

  // 6. All fallbacks exhausted
  throw new Error(`Semua model di ${customModelName} gagal`);
}
```

---

## Subcommands (`/router`)

| Subcommand | Description |
|---|---|
| `/router status` | Tampilkan config aktif, model definitions, thinking levels |
| `/router config <key> <value>` | Update config field (nulis ke file) |
| `/router reload` | Reload config dari file (dengan re-registration guard) |
| `/router help` | Bantuan |

---

## Yang Di-skip dari Original

| Fitur | Alasan |
|---|---|
| Heuristic routing (keyword/word-count/phase-bias) | Overkill untuk use case custom grouping |
| LLM classifier | Kompleksitas tinggi, perlu fast model + prompt |
| Cost budget / accumulated cost | Stateless, no need |
| Phase bias stickiness | Overengineering |
| State persistence (pin) | Skip v1, state dari file aja |
| Widget TUI | Skip, cukup status line |
| `/router pin/unpin` | Butuh persistence, kontradiksi |
| `image_support` di config | Detect otomatis dari modelRegistry |
| `thinking.prefer/min` object | Single level aja |

---

## Implementation Order

1. **`types.ts` + `constants.ts`** — interfaces & defaults
2. **`config.ts`** — load, merge, normalize, helpers
3. **`provider.ts`** — registerProvider + streamSimple loop
4. **`index.ts`** — entry point, wiring, hooks, closure state
5. **`commands.ts`** — /router subcommands
6. **`ui.ts`** — status line helpers
7. **Testing** — Vitest untuk config + provider

---

## Sumber Referensi

- Original yeliu84 codebase: `extensions/` dari https://github.com/yeliu84/pi-model-router
- Pi extension SDK: `extensions.md`, `custom-provider.md`, `models.md`
- Scout report: `.pi/plans/2026-06-28-router-extension/scout-context.md`
- Review: `.pi/plans/2026-06-28-router-extension/review.md`
