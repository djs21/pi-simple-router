import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

export interface RouterConfig {
  models: Record<string, CustomModelConfig>
  providers?: Record<string, CustomProviderEntry>
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

// ---------------------------------------------------------------------------
// Custom provider types
// ---------------------------------------------------------------------------

export interface CustomProviderModel {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

export interface CustomProviderEntry {
  managed?: boolean
  baseUrl: string
  apiKey: string
  api: string
  authHeader?: boolean
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  models: CustomProviderModel[]
}

export type KeyHealth = 'healthy' | 'cooldown' | 'dead'
