# Handoff: pi-simple-router — Scope Selector Implementation

## Status

Commit [`82b240e`](https://github.com/djs21/pi-simple-router/commit/82b240e) pushed to `master`. Extension functional with fallback chain, interactive `/router` menu, model selector with fuzzy search, and scope-aware CRUD.

## What Was Done

### Scope Selector (global/project) — Latest Commit

- **`types.ts`**: Added `SaveScope = 'global' | 'project'` type
- **`config.ts`**: Added `loadSeparateConfigs()` (returns raw `{ global, project }` without merge) and `getModelSource()` (detects `'global' | 'project' | 'both' | 'none'`)
- **`commands.ts`**: Rewrote create/edit/delete/show to be scope-aware:
  - **Create**: After inputting name/models/thinking, prompts "Simpan di Global (semua folder) atau Project (folder ini aja)?"
  - **Edit**: Resolves model source via `getModelSource()`. If in both scopes, asks user which one to edit. Reads/writes to the correct scope file.
  - **Delete**: Same resolution, plus option to delete from both scopes
  - **Show**: Displays scope info next to model details

### Previous Work (All Shipped)

| Feature | Details |
|---|---|
| Eager provider registration | Provider registered at extension load, re-registers when `modelRegistry` transitions null→nonnull |
| Fallback chain | `routeStream()` tries models in order, degrades thinking level if fallback has lower capability, filters by image support |
| Config merge | `loadRouterConfig()` merges global → project (project overrides) |
| Interactive `/router` menu | Buat/Edit/Hapus/Lihat with fuzzy-searchable model picker |
| Unit tests | 50 Vitest tests passing |
| Custom model selector | `model-selector.ts` using `ctx.ui.custom()` with Input, fuzzy filter, arrow key navigation |
| README | 300 lines Indonesian, covers install/config/usage/fallback flow/commands/development |

### Repository

- **Origin**: `git@github-pribadi:djs21/pi-simple-router.git`
- **Install**: `pi install git:github.com/djs21/pi-simple-router`
- **Local**: `/home/djs/project/pi-model-router`
- **Installed copy**: `/home/djs/.pi/agent/git/github.com/djs21/pi-simple-router/`

## Architecture

### File Structure

```
extensions/
├── types.ts          — RouterConfig, CustomModelConfig, SaveScope
├── constants.ts      — PROVIDER_NAME="router", CONFIG_FILENAME="model-router.json"
├── config.ts         — loadRouterConfig(), normalizeConfig(), loadSeparateConfigs(), getModelSource(), + helpers
├── provider.ts       — registerRouterProvider(), buildModels(), routeStream() (fallback chain engine)
├── ui.ts             — setStatusLine(), formatFallbackNotification()
├── model-selector.ts — Fuzzy-searchable model picker component
├── commands.ts       — /router interactive menu + scope-aware CRUD
└── index.ts          — Extension entry: eager registration + session_start hook
```

### Config Files

- **Global**: `~/.pi/agent/model-router.json` — available in all folders
- **Project**: `./.pi/model-router.json` — folder-specific overrides
- Merge: `{ ...global.models, ...project.models }` — project wins on conflict

### Known Issues

1. **`provider.test.ts`**: Pre-existing TypeScript error at line 20 (`TS7053` — `Symbol.asyncIterator` not mockable). Tests still pass (50/50). Not related to scope changes.

## Suggested Skills

- **`diagnose`**: If runtime errors appear during fallback chain execution, especially auth or rate-limit issues
- **`write-a-skill`**: If user wants to create a pi skill that integrates with router models
- **`browser-search`**: If user asks about pi SDK internals, model-registry validation, or openrouter API behavior
- **`tdd`**: When adding new features or fixing bugs — tests already exist (Vitest)

## Key Personas & Contact

- **User** (djs): Indonesian speaker, prefers concise code, hates overengineering, calls assistant "bro/gue"
- Uses: cmux, herdr, pi coding agent, openrouter models, subagent orchestration pattern

## Relevant Artifacts

- **Plan**: `docs/plan.md`
- **Example config**: `model-router.example.json`
- **Commit log**: `82b240e` (scope selector), `54b7d97` (eager registration fix), `5dca824` (interactive menu)
