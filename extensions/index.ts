import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RouterConfig } from './types.js'
import { PROVIDER_NAME } from './constants.js'
import { loadRouterConfig } from './config.js'
import { registerRouterProvider } from './provider.js'
import { registerCommands } from './commands.js'
import { setStatusLine } from './ui.js'

export default function routerExtension(api: ExtensionAPI): void {
  // --- Closure state ---
  let currentConfig: RouterConfig = { models: {} }
  let lastModelsFingerprint = ''
  let modelRegistry: any = null

  // --- Helpers ---
  function computeFingerprint(config: RouterConfig): string {
    return JSON.stringify(config.models)
  }

  async function loadAndRegister(): Promise<void> {
    const config = await loadRouterConfig()
    currentConfig = config

    // Re-registration guard
    const fp = computeFingerprint(config)
    if (fp === lastModelsFingerprint && modelRegistry) {
      return // skip, same config
    }

    lastModelsFingerprint = fp
    registerRouterProvider(api, config, modelRegistry)
  }

  // --- Hooks ---
  api.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    // Dapatkan modelRegistry dari ctx atau api
    modelRegistry = (api as any).modelRegistry ?? (ctx as any).modelRegistry

    await loadAndRegister()
    setStatusLine(ctx, `🔀 Router: ${Object.keys(currentConfig.models).length} models`)
  })

  api.on('session_shutdown', () => {
    // nothing to clean up
  })

  // --- Register commands ---
  registerCommands(api, () => currentConfig, loadAndRegister)

  // --- Initial status ---
  console.log('[router-extension] Loaded. Config models:', Object.keys(currentConfig.models).length)
}
