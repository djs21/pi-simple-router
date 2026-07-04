/**
 * Key management commands for the /router keys submenu.
 *
 * Provides handler functions for:
 *   status — display key pool overview + per-key health
 *   reload — reload keys config from file
 *   clearcache — reset all key state
 *   add — interactively add a key to a provider
 *   remove — interactively remove a key from a provider
 *   help — show available subcommands
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { ModelKeyPool } from './key-pool'
import type { KeyPoolConfig, KeyHealth } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEYS_SUBCOMMANDS = [
  { name: 'status', description: 'Tampilkan status key pool + health per-key' },
  { name: 'reload', description: 'Reload konfigurasi keys dari file' },
  { name: 'add', description: 'Tambah API key baru (interaktif)' },
  { name: 'remove', description: 'Hapus API key (interaktif)' },
  { name: 'clearcache', description: 'Reset semua state key (cooldown/dead)' },
  { name: 'help', description: 'Tampilkan bantuan' },
]

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a single pool's overview line.
 * Example: "openrouter — 3 keys (2✓ 1⏳) | round-robin"
 */
export function formatPoolStatus(pool: {
  provider: string
  keys: string[]
  health: Record<string, KeyHealth>
  strategy: string
}): string {
  const counts = { healthy: 0, cooldown: 0, dead: 0 }
  for (const key of pool.keys) {
    const h = pool.health[key]
    if (h === 'healthy') counts.healthy++
    else if (h === 'cooldown') counts.cooldown++
    else if (h === 'dead') counts.dead++
  }

  const parts: string[] = []
  if (counts.healthy > 0) parts.push(`${counts.healthy}✓`)
  if (counts.cooldown > 0) parts.push(`${counts.cooldown}⏳`)
  if (counts.dead > 0) parts.push(`${counts.dead}✗`)

  const suffix = parts.length > 0 ? ` (${parts.join(' ')})` : ''
  return `${pool.provider} — ${pool.keys.length} keys${suffix} | ${pool.strategy}`
}

/**
 * Truncate a key to the first 12 characters for display, plus "..." if longer.
 */
function truncateKey(apiKey: string): string {
  return apiKey.length > 12 ? apiKey.slice(0, 12) + '...' : apiKey
}

/**
 * Format footer status line for the footer.
 * Example: "🔑 OR:3 (2✓ 1⏳)" or "🔑 (no keys configured)"
 *
 * Abbreviation: first letter uppercase + last letter of each word-part uppercase.
 * For a single-word name like "openrouter" -> O + R = "OR".
 * For "open-router" -> O + R = "OR".
 */
export function formatFooterStatus(
  keyPool: ModelKeyPool | null,
): string {
  if (!keyPool) return '🔑 (no keys configured)'

  const statuses = keyPool.getStatus()
  if (statuses.length === 0) return '🔑 (no keys configured)'

  const lines: string[] = []
  for (const pool of statuses) {
    // Abbreviate: first letter + last letter of name, uppercased
    const name = pool.provider
    const abbr = (name[0] + name[name.length - 1]).toUpperCase()

    const counts = { healthy: 0, cooldown: 0, dead: 0 }
    for (const key of pool.keys) {
      const h = pool.health[key]
      if (h === 'healthy') counts.healthy++
      else if (h === 'cooldown') counts.cooldown++
      else if (h === 'dead') counts.dead++
    }

    const parts: string[] = []
    if (counts.healthy > 0) parts.push(`${counts.healthy}✓`)
    if (counts.cooldown > 0) parts.push(`${counts.cooldown}⏳`)
    if (counts.dead > 0) parts.push(`${counts.dead}✗`)

    lines.push(`${abbr}:${pool.keys.length} (${parts.join(' ')})`)
  }

  return `🔑 ${lines.join(' ')}`
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function cmdStatus(
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
): Promise<void> {
  const statuses = keyPool.getStatus()

  if (statuses.length === 0) {
    ctx.ui.notify('🔑 No keys configured', 'info')
    return
  }

  const lines: string[] = ['🔑 Key Pool Status']
  for (const pool of statuses) {
    lines.push('')
    lines.push(formatPoolStatus(pool))
    // Per-key detail
    for (const key of pool.keys) {
      const health = pool.health[key]
      const truncated = truncateKey(key)
      lines.push(`  ${truncated} → ${health}`)
    }
  }

  ctx.ui.notify(lines.join('\n'), 'info')
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

async function cmdReload(
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
  keysConfigLoader: () => KeyPoolConfig,
): Promise<void> {
  const config = keysConfigLoader()
  keyPool.reload(config)
  ctx.ui.notify('🔄 Keys config reloaded', 'info')
}

// ---------------------------------------------------------------------------
// Clear cache
// ---------------------------------------------------------------------------

function cmdClearCache(
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
): void {
  keyPool.clear()
  ctx.ui.notify('🧹 Key cache cleared', 'info')
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

async function cmdAdd(
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
  keysConfigLoader: () => KeyPoolConfig,
  keysConfigWriter: (config: KeyPoolConfig) => void,
  providerArg?: string,
): Promise<void> {
  const provider = providerArg || await ctx.ui.input('Nama provider (e.g. openrouter)', 'openrouter')
  if (!provider) {
    ctx.ui.notify('⚠️ Add cancelled', 'warning')
    return
  }

  const apiKey = await ctx.ui.input('API key', '')
  if (!apiKey) {
    ctx.ui.notify('⚠️ Add cancelled', 'warning')
    return
  }

  // Read current config, add key, write back
  const config = keysConfigLoader()
  if (!config.providers[provider]) {
    config.providers[provider] = { keys: [], strategy: 'round-robin' }
  }
  config.providers[provider].keys.push(apiKey)
  keysConfigWriter(config)

  // Reload pool
  keyPool.reload(config)

  ctx.ui.notify(`✅ Key added to ${provider}`, 'info')
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function cmdRemove(
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
  keysConfigLoader: () => KeyPoolConfig,
  keysConfigWriter: (config: KeyPoolConfig) => void,
  providerArg?: string,
): Promise<void> {
  const provider = providerArg || await ctx.ui.input('Nama provider (e.g. openrouter)', 'openrouter')
  if (!provider) {
    ctx.ui.notify('⚠️ Remove cancelled', 'warning')
    return
  }

  // Read current config
  const config = keysConfigLoader()
  const providerKeys = config.providers[provider]?.keys
  if (!providerKeys || providerKeys.length === 0) {
    ctx.ui.notify(`⚠️ No keys found for provider "${provider}"`, 'warning')
    return
  }

  // Show key selector
  const selectedKey = await ctx.ui.select(
    `Pilih key untuk dihapus dari ${provider}`,
    providerKeys,
  )
  if (!selectedKey) {
    ctx.ui.notify('⚠️ Remove cancelled', 'warning')
    return
  }

  // Remove key
  config.providers[provider].keys = providerKeys.filter((k) => k !== selectedKey)

  // Clean up empty providers
  if (config.providers[provider].keys.length === 0) {
    delete config.providers[provider]
  }

  keysConfigWriter(config)

  // Reload pool
  keyPool.reload(config)

  ctx.ui.notify(`🗑️ Key removed from ${provider}`, 'info')
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function cmdHelp(ctx: ExtensionCommandContext): void {
  const lines = KEYS_SUBCOMMANDS.map(
    (s) => `  ${s.name.padEnd(10)} — ${s.description}`,
  )
  ctx.ui.notify(`/router keys commands:\n${lines.join('\n')}`, 'info')
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a /router keys subcommand.
 *
 * @param args - Full argument string after "keys" (e.g. "status", "add openrouter")
 * @param ctx - Extension command context for UI interaction
 * @param keyPool - Key pool instance
 * @param keysConfigLoader - Function to load current keys config from files
 * @param keysConfigWriter - Function to persist updated keys config to files
 */
export async function handleKeysCommand(
  args: string,
  ctx: ExtensionCommandContext,
  keyPool: ModelKeyPool,
  keysConfigLoader: () => KeyPoolConfig,
  keysConfigWriter?: (config: KeyPoolConfig) => void,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const [subcmd, ...rest] = parts

  // Use passthrough writer by default (no-op for read-only commands)
  const writer = keysConfigWriter ?? ((_: KeyPoolConfig) => {})

  switch (subcmd) {
    case 'status':
      await cmdStatus(ctx, keyPool)
      break
    case 'reload':
      await cmdReload(ctx, keyPool, keysConfigLoader)
      break
    case 'clearcache':
      cmdClearCache(ctx, keyPool)
      break
    case 'add':
      await cmdAdd(ctx, keyPool, keysConfigLoader, writer, rest[0])
      break
    case 'remove':
      await cmdRemove(ctx, keyPool, keysConfigLoader, writer, rest[0])
      break
    case 'help':
    default:
      cmdHelp(ctx)
      break
  }
}
