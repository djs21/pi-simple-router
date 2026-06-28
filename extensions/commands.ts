import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { RouterConfig } from './types.js'

const SUBCOMMANDS: Array<{
  name: string
  description: string
}> = [
  { name: 'status', description: 'Lihat config aktif' },
  { name: 'reload', description: 'Reload config dari file' },
  { name: 'help', description: 'Bantuan' },
]

export function registerCommands(
  api: ExtensionAPI,
  getConfig: () => RouterConfig,
  reloadConfig: () => Promise<void>,
): void {
  api.registerCommand('router', {
    description: 'Custom model router commands',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const [subcmd] = parts

      switch (subcmd) {
        case 'status': {
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

        case 'reload': {
          await reloadConfig()
          ctx.ui.notify('🔄 Router config reloaded', 'info')
          return
        }

        case 'help':
        default: {
          const helpLines = SUBCOMMANDS.map(
            (s) => `  ${s.name.padEnd(10)} — ${s.description}`,
          )
          ctx.ui.notify(`/router commands:\n${helpLines.join('\n')}`, 'info')
          return
        }
      }
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
