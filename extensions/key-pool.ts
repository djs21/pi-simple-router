import type { KeyPoolConfig, KeyHealth, RotationStrategy } from './types'

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface KeyEntry {
  apiKey: string
  headers: Record<string, string>
  status: KeyHealth
  failures: number
  /** Timestamp (ms) when this key recovers. 0 = not in cooldown/dead. */
  until: number
}

interface ProviderPool {
  strategy: RotationStrategy
  keys: KeyEntry[]
  currentIndex: number
}

// ---------------------------------------------------------------------------
// Default durations
// ---------------------------------------------------------------------------

const DEFAULT_KEY_COOLDOWN_MS = 60_000
const DEFAULT_KEY_DEAD_MS = 300_000

/** Classify an error to determine key health and recovery duration. */
function classifyError(
  err: Error,
): { status: Exclude<KeyHealth, 'healthy'>; durationMs: number } {
  const msg = err.message.toLowerCase()

  // Rate-limit errors (429, etc.) → cooldown
  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit')
  ) {
    return { status: 'cooldown', durationMs: DEFAULT_KEY_COOLDOWN_MS }
  }

  // Auth errors (401, 403, etc.) → dead
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid api key')
  ) {
    return { status: 'dead', durationMs: DEFAULT_KEY_DEAD_MS }
  }

  // Server errors (5xx, etc.) → cooldown
  if (
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout')
  ) {
    return { status: 'cooldown', durationMs: DEFAULT_KEY_COOLDOWN_MS }
  }

  // Default: cooldown
  return { status: 'cooldown', durationMs: DEFAULT_KEY_COOLDOWN_MS }
}

// ---------------------------------------------------------------------------
// Key pool
// ---------------------------------------------------------------------------

export class ModelKeyPool {
  private pools = new Map<string, ProviderPool>()

  constructor(config: KeyPoolConfig) {
    for (const [provider, entry] of Object.entries(config.providers)) {
      const keys: KeyEntry[] = entry.keys.map((k) => ({
        apiKey: k,
        headers: entry.headers ?? {},
        status: 'healthy' as KeyHealth,
        failures: 0,
        until: 0,
      }))
      this.pools.set(provider, {
        strategy: entry.strategy ?? 'round-robin',
        keys,
        currentIndex: 0,
      })
    }
  }

  getNextKey(
    provider: string,
  ): { apiKey: string; headers: Record<string, string> } | null {
    const pool = this.pools.get(provider)
    if (!pool) return null
    if (pool.keys.length === 0) return null

    for (const key of pool.keys) {
      if (this.isHealthy(key)) {
        return { apiKey: key.apiKey, headers: { ...key.headers } }
      }
    }

    return null
  }

  markFailed(
    provider: string,
    apiKey: string,
    err: Error,
  ): void {
    const pool = this.pools.get(provider)
    if (!pool) return

    const key = pool.keys.find((k) => k.apiKey === apiKey)
    if (!key) return

    const { status, durationMs } = classifyError(err)
    key.status = status
    key.failures++
    key.until = Date.now() + durationMs
  }

  markSuccess(provider: string, apiKey: string): void {
    const pool = this.pools.get(provider)
    if (!pool) return

    const key = pool.keys.find((k) => k.apiKey === apiKey)
    if (!key) return

    key.status = 'healthy'
    key.failures = 0
    key.until = 0
  }

  getStatus(): Array<{
    provider: string
    keys: string[]
    health: Record<string, KeyHealth>
    strategy: RotationStrategy
  }> {
    const result: Array<{
      provider: string
      keys: string[]
      health: Record<string, KeyHealth>
      strategy: RotationStrategy
    }> = []

    for (const [provider, pool] of this.pools) {
      const health: Record<string, KeyHealth> = {}
      const keys: string[] = []
      for (const key of pool.keys) {
        keys.push(key.apiKey)
        health[key.apiKey] = key.status
      }
      result.push({ provider, keys, health, strategy: pool.strategy })
    }

    return result.sort((a, b) => a.provider.localeCompare(b.provider))
  }

  reload(config: KeyPoolConfig): void {
    this.pools.clear()
    for (const [provider, entry] of Object.entries(config.providers)) {
      const keys: KeyEntry[] = entry.keys.map((k) => ({
        apiKey: k,
        headers: entry.headers ?? {},
        status: 'healthy' as KeyHealth,
        failures: 0,
        until: 0,
      }))
      this.pools.set(provider, {
        strategy: entry.strategy ?? 'round-robin',
        keys,
        currentIndex: 0,
      })
    }
  }

  clear(): void {
    for (const [, pool] of this.pools) {
      for (const key of pool.keys) {
        key.status = 'healthy'
        key.failures = 0
        key.until = 0
      }
    }
  }

  private isHealthy(key: KeyEntry): boolean {
    if (key.status === 'healthy') return true
    if (key.until > 0 && Date.now() >= key.until) {
      key.status = 'healthy'
      key.failures = 0
      key.until = 0
      return true
    }
    return false
  }
}
