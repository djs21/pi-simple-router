import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import { showModelSelector, buildModelOptions } from './model-selector.js'
import type { RouterConfig, CustomModelConfig, SaveScope } from './types.js'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { CONFIG_FILENAME, PROVIDER_NAME } from './constants.js'
import { loadSeparateConfigs, getModelSource, normalizeConfig, type ModelSource } from './config.js'
import { getActiveRateLimits, clearRateLimits, isRateLimited } from './rate-limit-tracker.js'
import type { UsageRow } from './usage-tracker.js'

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
  { name: 'status', description: 'Lihat config aktif + cooldown' },
  { name: 'cd', description: 'Lihat cooldown aktif + eskalasi (alias: cooldown)' },
  { name: 'reload', description: 'Reload config dari file' },
  { name: 'clearcache', description: 'Reset cooldown cache' },
  { name: 'cost', description: 'Lihat usage cost history (opsional: nama_router, --since=1w)' },
  { name: 'cleanup', description: 'Hapus usage records lama: 24h, 1w, 1m, 2m, all' },
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

function formatUsageTable(rows: UsageRow[]): string {
  let totalTokens = 0
  let totalCost = 0
  const cols: string[] = []
  for (const row of rows) {
    totalTokens += row.totalTokens
    totalCost += row.costTotal
    const costStr = `$${row.costTotal.toFixed(4)}`
    const date = new Date(row.timestamp).toLocaleString()
    cols.push(
      `  ${row.modelRef.padEnd(30)} ${String(row.inputTokens).toLocaleString().padStart(8)} ${String(row.outputTokens).toLocaleString().padStart(8)} ${String(row.totalTokens).toLocaleString().padStart(8)} ${costStr.padStart(10)}  ${date}`,
    )
  }
  const divider = '  ' + '─'.repeat(70)
  const totalCostStr = `$${totalCost.toFixed(4)}`
  return [
    `  ${'Model'.padEnd(30)} ${'Input'.padStart(8)} ${'Output'.padStart(8)} ${'Total'.padStart(8)} ${'Cost'.padStart(10)}  Timestamp`,
    `  ${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)}  ${'─'.repeat(20)}`,
    ...cols,
    divider,
    `  ${'TOTAL'.padEnd(30)} ${' '.repeat(8)} ${' '.repeat(8)} ${String(totalTokens).toLocaleString().padStart(8)} ${totalCostStr.padStart(10)}`,
  ].join('\n')
}

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
          lines.push('⏳ Cooldowns (with escalation):')
          for (const { ref, remainingMs, errorType, consecutive } of limits) {
            const mins = Math.floor(remainingMs / 60_000)
            const secs = Math.ceil((remainingMs % 60_000) / 1000)
            const remaining = mins >= 1 ? `${mins}m ${secs}s` : `${secs}s`

            let tierLabel = '→ 5m tier'
            if (consecutive >= 7) tierLabel = '→ 6h tier'
            else if (consecutive >= 5) tierLabel = '→ 1h tier'

            lines.push(`  ${ref} — ${remaining} (${errorType}, consecutive: ${consecutive} ${tierLabel})`)
          }
        }

        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      if (subcmd === 'reload') {
        await reloadConfig()
        // Update active model status if a router model is active
        const model = (ctx as any).model
        if (model?.provider === PROVIDER_NAME) {
          const config = getMerged()
          const cfg = config.models[model.id]
          if (cfg) {
            const active = cfg.models.find((ref: string) => !isRateLimited(ref))
            ctx.ui.setStatus('router-chain', active ? `📎 ${active}` : '📎 (semua cooldown)')
          }
        }
        ctx.ui.notify('🔄 Router config reloaded', 'info')
        return
      }

      if (subcmd === 'cd' || subcmd === 'cooldown') {
        const lines = ['⏳ Cooldowns:']
        const limits = getActiveRateLimits()
        if (limits.length === 0) {
          lines.push('  (none)')
        } else {
          for (const { ref, remainingMs, errorType, consecutive } of limits) {
            const mins = Math.floor(remainingMs / 60_000)
            const secs = Math.ceil((remainingMs % 60_000) / 1000)
            const remaining = mins >= 1 ? `${mins}m ${secs}s` : `${secs}s`

            let tierLabel = '→ 5m tier'
            if (consecutive >= 7) tierLabel = '→ 6h tier'
            else if (consecutive >= 5) tierLabel = '→ 1h tier'

            lines.push(`  ${ref} — ${remaining} (${errorType}, consecutive: ${consecutive} ${tierLabel})`)
          }
        }
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      if (subcmd === 'clearcache') {
        clearRateLimits()
        ctx.ui.notify('🧹 Cooldown cache cleared', 'info')
        return
      }

      if (subcmd === 'cost') {
        const costArgs = parts.slice(1)
        let routerRef: string | undefined
        let since: number | undefined

        for (const arg of costArgs) {
          if (arg.startsWith('--since=')) {
            const val = arg.split('=')[1].toLowerCase()
            const now = Date.now()
            if (val === '24h') since = now - 86400000
            else if (val === '1w') since = now - 604800000
            else if (val === '1m') since = now - 2592000000
            else if (val === '2m') since = now - 5184000000
            else if (val !== 'all') {
              ctx.ui.notify('⚠️ Invalid --since. Use: 24h | 1w | 1m | 2m | all', 'warning')
              return
            }
          } else if (arg === '--since') {
            ctx.ui.notify('⚠️ Use --since=24h format (with equals sign)', 'warning')
            return
          } else {
            routerRef = arg
          }
        }

        const { queryUsage } = await import('./usage-tracker')
        const rows = queryUsage({ routerRef, since })

        if (rows.length === 0) {
          ctx.ui.notify('📊 No usage records found.', 'info')
          return
        }

        const lines: string[] = []

        if (!routerRef) {
          // Aggregate per router config
          const grouped = new Map<string, UsageRow[]>()
          for (const row of rows) {
            const list = grouped.get(row.routerRef) ?? []
            list.push(row)
            grouped.set(row.routerRef, list)
          }

          lines.push(`📊 Usage (aggregate):`)
          lines.push('')
          let grandTotal = 0
          let grandInput = 0
          let grandOutput = 0
          for (const [group, groupRows] of grouped) {
            const cost = groupRows.reduce((s, r) => s + r.costTotal, 0)
            const input = groupRows.reduce((s, r) => s + r.inputTokens, 0)
            const output = groupRows.reduce((s, r) => s + r.outputTokens, 0)
            grandTotal += cost
            grandInput += input
            grandOutput += output
            lines.push(`  ${group.padEnd(16)} $${cost.toFixed(4)}  (${input.toLocaleString()} → ${output.toLocaleString()})`)
          }
          lines.push(`  ${'─'.repeat(40)}`)
          lines.push(`  ${'Total'.padEnd(16)} $${grandTotal.toFixed(4)}  (${grandInput.toLocaleString()} → ${grandOutput.toLocaleString()})`)
        } else {
          lines.push(`📊 Usage for "${routerRef}":`)
          lines.push('')
          lines.push(formatUsageTable(rows))
        }

        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      if (subcmd === 'cleanup') {
        const intervalArg = parts[1]?.toLowerCase()
        const validIntervals = ['24h', '1w', '1m', '2m', 'all']
        if (!intervalArg || !validIntervals.includes(intervalArg)) {
          ctx.ui.notify('⚠️ Usage: /router cleanup 24h | 1w | 1m | 2m | all', 'warning')
          return
        }

        let before: number = Number.MAX_SAFE_INTEGER
        const now = Date.now()
        switch (intervalArg) {
          case '24h': before = now - 86400000; break
          case '1w':  before = now - 604800000; break
          case '1m':  before = now - 2592000000; break
          case '2m':  before = now - 5184000000; break
        }

        const { cleanupUsage } = await import('./usage-tracker')
        const deleted = cleanupUsage(before)
        ctx.ui.notify(`🧹 Deleted ${deleted} usage records (${intervalArg} threshold).`, 'info')
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

      const [subcmd] = parts
      if (subcmd === 'cost') {
        return [
          { value: '--since=24h', label: '--since=24h', description: 'Last 24 hours' },
          { value: '--since=1w', label: '--since=1w', description: 'Last week' },
          { value: '--since=1m', label: '--since=1m', description: 'Last month' },
          { value: '--since=2m', label: '--since=2m', description: 'Last 2 months' },
          { value: '--since=all', label: '--since=all', description: 'All time' },
        ]
      }

      if (subcmd === 'cleanup') {
        return [
          { value: '24h', label: '24h', description: 'Older than 24 hours' },
          { value: '1w', label: '1w', description: 'Older than 1 week' },
          { value: '1m', label: '1m', description: 'Older than 1 month' },
          { value: '2m', label: '2m', description: 'Older than 2 months' },
          { value: 'all', label: 'all', description: 'Delete all records' },
        ]
      }

      return null
    },
  })
}
