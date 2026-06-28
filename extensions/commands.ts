import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { RouterConfig, CustomModelConfig } from './types.js'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import { CONFIG_FILENAME } from './constants.js'
import { writeFileSync } from 'fs'
import { join } from 'path'

const MAIN_MENU = [
  '🔧 Buat router baru',
  '✏️  Edit router',
  '🗑️  Hapus router',
  '👁️  Lihat router',
  '🚪 Keluar',
]

const SUBCOMMANDS: Array<{
  name: string
  description: string
}> = [
  { name: 'status', description: 'Lihat config aktif' },
  { name: 'reload', description: 'Reload config dari file' },
  { name: 'help', description: 'Bantuan' },
]

function saveConfig(config: RouterConfig): void {
  const projectPath = join(process.cwd(), '.pi', CONFIG_FILENAME)
  writeFileSync(projectPath, JSON.stringify(config, null, 2) + '\n')
}

function getRouterNames(config: RouterConfig): string[] {
  return Object.keys(config.models).sort()
}

// === Interactive Menu Logic ===

async function mainMenu(
  ctx: ExtensionCommandContext,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): Promise<void> {
  let running = true
  while (running) {
    const choice = await ctx.ui.select('🔀 Router Manager', MAIN_MENU)
    if (!choice) continue // ESC → stay in menu

    switch (choice) {
      case '🔧 Buat router baru':
        await createRouter(ctx, getConfig, reloadConfig)
        break
      case '✏️  Edit router':
        await editRouter(ctx, getConfig, reloadConfig)
        break
      case '🗑️  Hapus router':
        await deleteRouter(ctx, getConfig, reloadConfig)
        break
      case '👁️  Lihat router':
        await showRouter(ctx, getConfig)
        break
      case '🚪 Keluar':
        running = false
        break
    }
  }
}

async function createRouter(
  ctx: ExtensionCommandContext,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): Promise<void> {
  const name = await ctx.ui.input('Nama router baru', 'thinker')
  if (!name) return // ESC → main menu

  while (true) {
    const modelsStr = await ctx.ui.input(
      'Daftar model (pisah spasi)',
      'opencode-go/deepseek-v4-pro mimo-2.5-pro',
    )
    if (!modelsStr) return // ESC → main menu

    const thinking = await ctx.ui.input(
      'Thinking level (opsional, kosongkan default)',
      'high',
    )
    if (thinking === undefined) continue // ESC → back to models input

    const entry: CustomModelConfig = {
      models: modelsStr.split(/\s+/).filter(Boolean),
    }
    if (thinking) {
      entry.thinking = thinking as ThinkingLevel
    }

    const config = getConfig()
    config.models[name] = entry
    saveConfig(config)
    await reloadConfig()
    ctx.ui.notify(`✅ Router '${name}' berhasil dibuat!`, 'info')
    return
  }
}

async function editRouter(
  ctx: ExtensionCommandContext,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): Promise<void> {
  const config = getConfig()
  const names = getRouterNames(config)
  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router', names)
  if (!selectedName) return // ESC → main menu

  while (true) {
    const field = await ctx.ui.select('Field yang diedit', ['models', 'thinking'])
    if (!field) return // ESC → main menu

    const existing = config.models[selectedName]

    if (field === 'models') {
      const currentValue = existing.models.join(' ')
      const modelsStr = await ctx.ui.input(
        'Daftar model baru (pisah spasi)',
        currentValue,
      )
      if (!modelsStr) continue // ESC → back to field select

      config.models[selectedName] = {
        ...existing,
        models: modelsStr.split(/\s+/).filter(Boolean),
      }
    } else {
      const currentValue = existing.thinking ?? ''
      const newThinking = await ctx.ui.input(
        'Thinking level baru (kosongkan untuk default)',
        currentValue,
      )
      if (newThinking === undefined) continue // ESC → back to field select

      config.models[selectedName] = {
        ...existing,
        thinking: (newThinking || undefined) as ThinkingLevel | undefined,
      }
    }

    saveConfig(config)
    await reloadConfig()
    ctx.ui.notify(`✏️ Router '${selectedName}' berhasil diupdate!`, 'info')
    return
  }
}

async function deleteRouter(
  ctx: ExtensionCommandContext,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): Promise<void> {
  const config = getConfig()
  const names = getRouterNames(config)
  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router yang mau dihapus', names)
  if (!selectedName) return // ESC → main menu

  const confirmed = await ctx.ui.confirm(
    'Hapus router?',
    `Yakin mau hapus router '${selectedName}'?`,
  )
  if (!confirmed) return // ESC or No → main menu

  delete config.models[selectedName]
  saveConfig(config)
  await reloadConfig()
  ctx.ui.notify(`🗑️ Router '${selectedName}' berhasil dihapus!`, 'info')
}

async function showRouter(
  ctx: ExtensionCommandContext,
  getConfig: () => RouterConfig,
): Promise<void> {
  const config = getConfig()
  const names = getRouterNames(config)
  if (names.length === 0) {
    ctx.ui.notify('⚠️ Belum ada router. Buat dulu.', 'warning')
    return
  }

  const selectedName = await ctx.ui.select('Pilih router', names)
  if (!selectedName) return // ESC → main menu

  const cfg = config.models[selectedName]
  const modelsList = cfg.models.map((m) => `    → ${m}`).join('\n')
  const details = [
    `Router: ${selectedName}`,
    'Models:',
    modelsList,
    `Thinking: ${cfg.thinking ?? '(default)'}`,
  ].join('\n')
  ctx.ui.notify(details, 'info')
}

export function registerCommands(
  api: ExtensionAPI,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): void {
  api.registerCommand('router', {
    description: 'Custom model router commands (interactive)',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const [subcmd] = parts

      // Fast path: direct subcommands
      if (subcmd === 'status') {
        const config = getConfig()
        const modelNames = Object.keys(config.models)
        const lines: string[] = ['🔀 Router Status']
        lines.push(`Models: ${modelNames.length > 0 ? modelNames.join(', ') : '(none)'}`)
        for (const [name, cfg] of Object.entries(config.models)) {
          let line = `  ${name}: ${cfg.models.join(' → ')}`
          if (cfg.thinking) line += ` [thinking: ${cfg.thinking}]`
          lines.push(line)
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

      // No matching subcommand → interactive menu
      await mainMenu(ctx, getConfig, reloadConfig)
    },
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const trimmed = argumentPrefix.trimStart()
      const hasTrailingSpace = /\s$/.test(argumentPrefix)
      const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : []

      // Empty or partial subcommand → suggest matching subcommands
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

      // Already past the subcommand → no further completions
      return null
    },
  })
}
