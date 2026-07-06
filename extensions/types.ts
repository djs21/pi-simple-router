import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

export interface RouterConfig {
  models: Record<string, CustomModelConfig>
  /** Base cooldown duration in ms (default 300000). Escalation tiers are relative to this base. */
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
