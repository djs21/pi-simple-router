import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

export interface RouterConfig {
  models: Record<string, CustomModelConfig>
  rateLimitCooldownMs?: number
}

export interface CustomModelConfig {
  models: string[]
  thinking?: ThinkingLevel | null
}

export interface RouterState {
  currentModel: string | null
}

export type SaveScope = 'global' | 'project'

// ---------------------------------------------------------------------------
// Key pool types
// ---------------------------------------------------------------------------

export type RotationStrategy = 'round-robin' | 'fallback'

export interface ProviderKeyConfig {
  keys: string[]
  headers?: Record<string, string>
  strategy?: RotationStrategy
}

export interface KeyPoolConfig {
  providers: Record<string, ProviderKeyConfig>
}

export type KeyHealth = 'healthy' | 'cooldown' | 'dead'
