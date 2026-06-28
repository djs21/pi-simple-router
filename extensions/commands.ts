import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import { showModelSelector, buildModelOptions } from './model-selector.js'
import type { RouterConfig, CustomModelConfig, SaveScope } from './types.js'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { CONFIG_FILENAME } from './constants.js'
import { loadSeparateConfigs, getModelSource, normalizeConfig, type ModelSource } from './config.js'
import { getActiveRateLimits } from './rate-limit-tracker.js'

const MAIN_MENU = [
  '🔧 Buat router baru',
  '✏️  Edit router',
  '🗑️  Hapus router',
  '👁️  Lihat router',
  '🚪 Keluar',
]

const SCOPE_OPTIONS = [
  '🌍 Global — semua folder',
  '📁 Project — folder ini aja',
]

const SUBCOMMANDS: Array<{
  name: string
  description: string
}> = [
  { name: 'status', description: 'Lihat config aktif' },
  { name: 'reload', description: 'Reload config dari file' },
  { name: 'help', description: 'Bantuan' },
]

// ---------------------------------------------------------------------------
// File I/O per scope
// ---------------------------------------------------------------------------

function scopePath(scope: SaveScope): string {
  return scope === 'global'
    ? join(homedir(), '.pi', 'agent', CONFIG_FILENAME)
    : join(process.cwd(), '.pi', CONFIG_FILENAME)
}

function readScopeConfig(scope: SaveScope): RouterConfig {
  try {
    const raw = JSON.parse(readFileSync(scopePath(scope), 'utf-8'))
    return normalizeConfig(raw)
  } catch {
    return { models: {} }
  }
}

function writeScopeConfig(config: RouterConfig, scope: SaveScope): void {
  const path = scopePath(scope)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Model picker (unchanged)
// ---------------------------------------------------------------------------

async function pickModels(
  ctx: ExtensionCommandContext,
  getModelRegistry: () => any,
  preSelected?: string[],
): Promise<string[]> {
  const registry = getModelRegistry()
  const options = buildModelOptions(registry)
  const selected = new Set(preSelected ?? [])

  while (true) {
    const available = options.filter((o) => !selected.has(o.value))
    if (available.length === 0 && selected.size > 0) break

    const sortedOptions = [
      ...available.sort((a, b) => a.value.localeCompare(b.value)),
    ]

    if (selected.size === 0 && available.length === 0) return []

    const pick = await showModelSelector(
      ctx,
      sortedOptions,
      `Pilih model (${selected.size} dipilih) — Enter tambah, Esc selesai`,
    )
    if (!pick) break // Esc → selesai

    selected.add(pick)
  }

  return [...selected]
}

// ---------------------------------------------------------------------------
// Scope picker
// ---------------------------------------------------------------------------

async function pickScope(
  ctx: ExtensionCommandContext,
  label: string,
): Promise<SaveScope | null> {
  const choice = await ctx.ui.select(label, SCOPE_OPTIONS)
  if (!choice) return null
  return choice.startsWith('🌍') ? 'global' : 'project'
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function mainMenu(
  ctx: ExtensionCommandContext,
  getMerged: () => RouterConfig,
  reloadConfig: () => Promise<void>,
  getModelRegistry: () => any,
): Promise<void> {
  let running = true
  while (running) {
    const choice = await ctx.ui.select('🔀 Router Manager', MAIN_MENU)
    if (!choice) continue

    switch (choice) {
      case '🔧 Buat router baru':
        await createRouter(ctx, getMerged, reloadConfig, getModelRegistry)
        break
      case '✏️  Edit router':
        await editRouter(ctx, getMerged, reloadConfig, getModelRegistry)
        break
      case '🗑️  Hapus router':
        await deleteRouter(ctx, getMerged, reloadConfig)
        break
      case '👁️  Lihat router':
        await showRouter(ctx, getMerged)
        break
      case '🚪 Keluar':
        running = false
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function createRouter(
  ctx: ExtensionCommandContext,
  _getMerged: () => RouterConfig,
  reloadConfig: () => Promise<void>,
  getModelRegistry: () => any,
): Promise<void> {
  const name = await ctx.ui.input('Nama router baru', 'thinker')
  if (!name) return

  const models = await pickModels(ctx, getModelRegistry)
  if (models.length === 0) {
    ctx.ui.notify('⚠️ Minimal pilih 1 model', 'warning')
    return
  }

  const thinking = await ctx.ui.input('Thinking level (opsional)', 'high')
  if (thinking === undefined) return

  const entry: CustomModelConfig = {
    models,
    ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
  }

  // Tanya scope
  const scope = await pickScope(ctx, '📦 Simpan di mana?')
  if (!scope) return

  const scopeConfig = readScopeConfig(scope)
  scopeConfig.models[name] = entry
  writeScopeConfig(scopeConfig, scope)

  await reloadConfig()
  ctx.ui.notify(`✅ Router '${name}' berhasil dibuat (${scope})!`, 'info')
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

async function editRouter(
  ctx: ExtensionCommandContext,
  _getMerged: () => RouterConfig,
  reloadConfig: () => Promise<void>,
  getModelRegistry: () => any,
): Promise<void> {
  const { global, project } = loadSeparateConfigs()
  const merged = { models: { ...global.models, ...project.models } }
  const names = Object.keys(merged.models).sort()

  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router', names)
  if (!selectedName) return

  // Cari asal model
  const source = await resolveEditSource(ctx, selectedName, global, project)
  if (!source) return

  // Field selection loop
  while (true) {
    const field = await ctx.ui.select('Field yang diedit', ['models', 'thinking'])
    if (!field) return

    // Baca konfigurasi terkini dari scope asal
    const scopeConfig = readScopeConfig(source)
    const existing = scopeConfig.models[selectedName]
    if (!existing) {
      ctx.ui.notify(`⚠️ Router '${selectedName}' tidak ditemukan di ${source}`, 'warning')
      return
    }

    if (field === 'models') {
      const action = await ctx.ui.select('Pilih aksi', [
        'Tambah model',
        'Hapus model',
        'Reset semua',
        'Batal',
      ])
      if (!action || action === 'Batal') continue

      if (action === 'Reset semua') {
        const newModels = await pickModels(ctx, getModelRegistry)
        if (newModels.length > 0) {
          scopeConfig.models[selectedName].models = newModels
        }
      } else if (action === 'Tambah model') {
        const addModels = await pickModels(ctx, getModelRegistry, existing.models)
        if (addModels.length > existing.models.length) {
          scopeConfig.models[selectedName].models = addModels
        }
      } else if (action === 'Hapus model') {
        if (existing.models.length === 0) {
          ctx.ui.notify('⚠️ Tidak ada model untuk dihapus', 'warning')
          continue
        }
        const toRemove = await ctx.ui.select('Pilih model yang dihapus', existing.models)
        if (toRemove) {
          scopeConfig.models[selectedName].models = existing.models.filter((m) => m !== toRemove)
        }
      }
    } else {
      const currentValue = existing.thinking ?? ''
      const newThinking = await ctx.ui.input(
        'Thinking level baru (kosongkan untuk default)',
        currentValue,
      )
      if (newThinking === undefined) continue

      scopeConfig.models[selectedName] = {
        ...existing,
        thinking: (newThinking || undefined) as ThinkingLevel | undefined,
      }
    }

    writeScopeConfig(scopeConfig, source)
    await reloadConfig()
    ctx.ui.notify(`✏️ Router '${selectedName}' diupdate di ${source}!`, 'info')
    return
  }
}

/**
 * Cari scope asal model. Kalo ada di kedua scope, tanya user.
 * Returns null kalo user cancel.
 */
async function resolveEditSource(
  ctx: ExtensionCommandContext,
  name: string,
  global: RouterConfig,
  project: RouterConfig,
): Promise<SaveScope | null> {
  const source = getModelSource(name, global, project)

  if (source === 'global') return 'global'
  if (source === 'project') return 'project'
  if (source === 'none') {
    ctx.ui.notify(`⚠️ Router '${name}' tidak ditemukan`, 'warning')
    return null
  }

  // 'both' — tanya user
  const choice = await ctx.ui.select(
    `Router '${name}' ada di global & project. Mau edit yang mana?`,
    ['🌍 Global', '📁 Project', 'Batal'],
  )
  if (!choice || choice === 'Batal') return null
  return choice.startsWith('🌍') ? 'global' : 'project'
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function deleteRouter(
  ctx: ExtensionCommandContext,
  _getMerged: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): Promise<void> {
  const { global, project } = loadSeparateConfigs()
  const merged = { models: { ...global.models, ...project.models } }
  const names = Object.keys(merged.models).sort()

  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router yang mau dihapus', names)
  if (!selectedName) return

  const source = getModelSource(selectedName, global, project)
  const scopesToDelete: SaveScope[] = []

  if (source === 'global') {
    scopesToDelete.push('global')
  } else if (source === 'project') {
    scopesToDelete.push('project')
  } else if (source === 'both') {
    // Tanya: global, project, atau dua-duanya?
    const choice = await ctx.ui.select(
      `Router '${selectedName}' ada di global & project. Hapus dari mana?`,
      ['🌍 Global', '📁 Project', 'Keduanya', 'Batal'],
    )
    if (!choice || choice === 'Batal') return

    if (choice === 'Keduanya') {
      scopesToDelete.push('global', 'project')
    } else {
      scopesToDelete.push(choice.startsWith('🌍') ? 'global' : 'project')
    }
  } else {
    ctx.ui.notify(`⚠️ Router '${selectedName}' tidak ditemukan`, 'warning')
    return
  }

  const scopeLabel = scopesToDelete.length === 1
    ? scopesToDelete[0]
    : 'global & project'
  const confirmed = await ctx.ui.confirm(
    'Hapus router?',
    `Yakin mau hapus router '${selectedName}' dari ${scopeLabel}?`,
  )
  if (!confirmed) return

  for (const scope of scopesToDelete) {
    const scopeConfig = readScopeConfig(scope)
    delete scopeConfig.models[selectedName]
    writeScopeConfig(scopeConfig, scope)
  }

  await reloadConfig()
  ctx.ui.notify(`🗑️ Router '${selectedName}' berhasil dihapus dari ${scopeLabel}!`, 'info')
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

async function showRouter(
  ctx: ExtensionCommandContext,
  getMerged: () => RouterConfig,
): Promise<void> {
  const config = getMerged()
  const names = Object.keys(config.models).sort()
  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router', names)
  if (!selectedName) return

  const cfg = config.models[selectedName]
  const modelsList = cfg.models.map((m) => `    → ${m}`).join('\n')

  // Tambah info scope
  const { global, project } = loadSeparateConfigs()
  const source = getModelSource(selectedName, global, project)
  const sourceLabel = source === 'both'
    ? 'global + project'
    : source

  const details = [
    `Router: ${selectedName}`,
    `Scope: ${sourceLabel}`,
    'Models:',
    modelsList,
    `Thinking: ${cfg.thinking ?? '(default)'}`,
  ].join('\n')
  ctx.ui.notify(details, 'info')
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerCommands(
  api: ExtensionAPI,
  getMerged: () => RouterConfig,
  reloadConfig: () => Promise<void>,
  getModelRegistry: () => any,
): void {
  api.registerCommand('router', {
    description: 'Custom model router commands (interactive)',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const [subcmd] = parts

      if (subcmd === 'status') {
        const config = getMerged()
        const modelNames = Object.keys(config.models)
        const lines: string[] = ['🔀 Router Status']
        lines.push(`Models: ${modelNames.length > 0 ? modelNames.join(', ') : '(none)'}`)
        for (const [name, cfg] of Object.entries(config.models)) {
          let line = `  ${name}: ${cfg.models.join(' → ')}`
          if (cfg.thinking) line += ` [thinking: ${cfg.thinking}]`
          lines.push(line)
        }

        // Active rate limits
        const limits = getActiveRateLimits()
        if (limits.length > 0) {
          lines.push('')
          lines.push('⏳ Rate Limit Cooldown:')
          for (const { ref, remainingMs } of limits) {
            const mins = Math.ceil(remainingMs / 60_000)
            const secs = Math.ceil((remainingMs % 60_000) / 1000)
            const remaining = mins >= 1 ? `${mins}m` : `${secs}d`
            lines.push(`  ${ref} — cooldown ${remaining} lagi`)
          }
        }

        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      if (subcmd === 'reload') {
        await reloadConfig()
        ctx.ui.notify('🔄 Router config reloaded', 'info')
        return
      }

      if (subcmd === 'help') {
        const helpLines = SUBCOMMANDS.map(
          (s) => `  ${s.name.padEnd(10)} — ${s.description}`,
        )
        ctx.ui.notify(`/router commands:\n${helpLines.join('\n')}`, 'info')
        return
      }

      await mainMenu(ctx, getMerged, reloadConfig, getModelRegistry)
    },
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const trimmed = argumentPrefix.trimStart()
      const hasTrailingSpace = /\s$/.test(argumentPrefix)
      const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : []

      if (parts.length === 0) {
        return SUBCOMMANDS.map((s) => ({
          value: s.name,
          label: s.name,
          description: s.description,
        }))
      }

      if (parts.length === 1 && !hasTrailingSpace) {
        const prefix = parts[0]
        const filtered = SUBCOMMANDS.filter((s) => s.name.startsWith(prefix)).map(
          (s) => ({
            value: s.name,
            label: s.name,
            description: s.description,
          }),
        )
        return filtered.length > 0 ? filtered : null
      }

      return null
    },
  })
}
