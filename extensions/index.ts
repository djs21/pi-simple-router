import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { RouterConfig } from './types.js'
import { loadRouterConfig } from './config.js'
import { registerRouterProvider } from './provider.js'
import { registerCommands } from './commands.js'
import { setStatusLine } from './ui.js'
import { PROVIDER_NAME } from './constants.js'
import { isRateLimited } from './rate-limit-tracker.js'
import { loadKeysConfig } from './keys-config.js'
import { ModelKeyPool } from './key-pool.js'

export default function routerExtension(api: ExtensionAPI): void {
  // --- Closure state ---
  let currentConfig: RouterConfig = { models: {} }
  let lastModelsFingerprint = ''
  let modelRegistry: any = null
  let keyPool: ModelKeyPool | null = null
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

    // Load key pool config
    const keysConfig = loadKeysConfig()
    if (Object.keys(keysConfig.providers).length > 0) {
      if (keyPool) {
        keyPool.reload(keysConfig)
      } else {
        keyPool = new ModelKeyPool(keysConfig)
      }
    }

    const haveRegistryNow = !!modelRegistry
    // Re-register if: config changed, or registry transitions null → available
    const needsReRegister = configChanged || (!lastRegistrationHadRegistry && haveRegistryNow)
    if (!needsReRegister) return

    lastRegistrationHadRegistry = haveRegistryNow
    registerRouterProvider(api, config, modelRegistry, keyPool)
  }

  // --- Eager registration ---
  loadAndRegister().catch((err) =>
    console.error('[router-extension] Eager registration failed:', err),
  )

  /** Update status to show which fallback model is currently active (first non-cooldowned). */
  function updateRouterChainStatus(ctx: ExtensionContext): void {
    const model = ctx.model
    if (model?.provider === PROVIDER_NAME) {
      const cfg = currentConfig.models[model.id]
      if (cfg) {
        // Find the first model NOT in cooldown — that's the one router will use
        const active = cfg.models.find((ref) => !isRateLimited(ref))
        if (active) {
          ctx.ui.setStatus('router-chain', `📎 ${active}`)
          return
        }
        // All models cooldowned
        ctx.ui.setStatus('router-chain', '📎 (semua cooldown)')
        return
      }
    }
    ctx.ui.setStatus('router-chain', undefined)
  }

  // --- Hooks ---
  api.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    if (!modelRegistry) {
      modelRegistry = (api as any).modelRegistry ?? (ctx as any).modelRegistry
    }

    await loadAndRegister()
    setStatusLine(ctx, `🔀 Router: ${Object.keys(currentConfig.models).length} models`)
    updateRouterChainStatus(ctx)
  })

  api.on('model_select', (_event: unknown, ctx: ExtensionContext) => {
    updateRouterChainStatus(ctx)
  })

  api.on('turn_start', (_event: unknown, ctx: ExtensionContext) => {
    updateRouterChainStatus(ctx)
  })

  api.on('session_shutdown', () => {
    // nothing to clean up
  })

  // --- Register commands ---
  registerCommands(api, () => currentConfig, loadAndRegister, () => modelRegistry)

  console.log('[router-extension] Loaded. Config models:', Object.keys(currentConfig.models).length)
}
