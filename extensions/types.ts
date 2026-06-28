import type { ThinkingLevel } from '@earendil-works/pi-agent-core'

export interface RouterConfig {
  models: Record<string, CustomModelConfig>
}

export interface CustomModelConfig {
  models: string[]
  thinking?: ThinkingLevel | null
}

export interface RouterState {
  currentModel: string | null
}
