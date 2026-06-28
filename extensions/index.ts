import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RouterConfig } from './types.js'
import { loadRouterConfig } from './config.js'
import { registerRouterProvider } from './provider.js'
import { registerCommands } from './commands.js'
import { setStatusLine } from './ui.js'

export default function routerExtension(api: ExtensionAPI): void {
  // --- Closure state ---
  let currentConfig: RouterConfig = { models: {} }
  let lastModelsFingerprint = ''
  let modelRegistry: any = null
  // Track whether the most recent registerRouterProvider call had a null registry.
  // When registry becomes available later (on session_start), we need to re-register
  // to update the streamSimple closure with the real registry.
  let lastRegistrationHadRegistry = false

  function computeFingerprint(config: RouterConfig): string {
    return JSON.stringify(config.models)
  }

  async function loadAndRegister(): Promise<void> {
    const config = await loadRouterConfig()
    currentConfig = config

    const configChanged = computeFingerprint(config) !== lastModelsFingerprint
    if (configChanged) {
      lastModelsFingerprint = computeFingerprint(config)
    }

    const haveRegistryNow = !!modelRegistry
    // Re-register if: config changed, or registry transitions null → available
    const needsReRegister = configChanged || (!lastRegistrationHadRegistry && haveRegistryNow)
    if (!needsReRegister) return

    lastRegistrationHadRegistry = haveRegistryNow
    registerRouterProvider(api, config, modelRegistry)
  }

  // --- Eager registration ---
  loadAndRegister().catch((err) =>
    console.error('[router-extension] Eager registration failed:', err),
  )

  // --- Hooks ---
  api.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    if (!modelRegistry) {
      modelRegistry = (api as any).modelRegistry ?? (ctx as any).modelRegistry
    }

    await loadAndRegister()
    setStatusLine(ctx, `🔀 Router: ${Object.keys(currentConfig.models).length} models`)
  })

  api.on('session_shutdown', () => {
    // nothing to clean up
  })

  // --- Register commands ---
  registerCommands(api, () => currentConfig, loadAndRegister, () => modelRegistry)

  console.log('[router-extension] Loaded. Config models:', Object.keys(currentConfig.models).length)
}
