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
  usageCount: number
  lastUsed: number | null
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
const ERROR_RATE_THRESHOLD = 5

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
        usageCount: 0,
        lastUsed: null,
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

    if (pool.strategy === 'fallback') {
      return this.fallbackNext(pool)
    }
    return this.roundRobinNext(pool)
  }

  private roundRobinNext(
    pool: ProviderPool,
  ): { apiKey: string; headers: Record<string, string> } | null {
    const healthy = this.healthyKeys(pool)
    if (healthy.length === 0) return null

    for (let i = 0; i < pool.keys.length; i++) {
      const idx = (pool.currentIndex + i) % pool.keys.length
      const key = pool.keys[idx]
      if (this.isHealthy(key)) {
        pool.currentIndex = (idx + 1) % pool.keys.length
        key.usageCount++
        key.lastUsed = Date.now()
        return { apiKey: key.apiKey, headers: { ...key.headers } }
      }
    }

    return null
  }

  private fallbackNext(
    pool: ProviderPool,
  ): { apiKey: string; headers: Record<string, string> } | null {
    for (const key of pool.keys) {
      if (this.isHealthy(key)) {
        key.usageCount++
        key.lastUsed = Date.now()
        return { apiKey: key.apiKey, headers: { ...key.headers } }
      }
    }

    return null
  }

  private healthyKeys(pool: ProviderPool): KeyEntry[] {
    return pool.keys.filter((k) => this.isHealthy(k))
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
    key.failures++

    if (key.failures >= ERROR_RATE_THRESHOLD) {
      key.status = 'dead'
      key.until = Date.now() + DEFAULT_KEY_DEAD_MS
    } else {
      key.status = status
      key.until = Date.now() + durationMs
    }
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
    failures: Record<string, number>
    usageCount: Record<string, number>
    lastUsed: Record<string, number | null>
    strategy: RotationStrategy
  }> {
    const result: Array<{
      provider: string
      keys: string[]
      health: Record<string, KeyHealth>
      failures: Record<string, number>
      usageCount: Record<string, number>
      lastUsed: Record<string, number | null>
      strategy: RotationStrategy
    }> = []

    for (const [provider, pool] of this.pools) {
      const health: Record<string, KeyHealth> = {}
      const failures: Record<string, number> = {}
      const usageCount: Record<string, number> = {}
      const lastUsed: Record<string, number | null> = {}
      const keys: string[] = []
      for (const key of pool.keys) {
        keys.push(key.apiKey)
        health[key.apiKey] = key.status
        failures[key.apiKey] = key.failures
        usageCount[key.apiKey] = key.usageCount
        lastUsed[key.apiKey] = key.lastUsed
      }
      result.push({ provider, keys, health, failures, usageCount, lastUsed, strategy: pool.strategy })
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
        usageCount: 0,
        lastUsed: null,
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
        key.usageCount = 0
        key.lastUsed = null
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
