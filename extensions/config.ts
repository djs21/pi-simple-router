import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { RouterConfig, CustomModelConfig, CustomProviderEntry } from './types'
import { CONFIG_FILENAME } from './constants'

const CONFIG_LEVELS: ThinkingLevel[] = ['xhigh', 'high', 'medium', 'low']

export const loadRouterConfig = (): RouterConfig => {
  const globalPath = join(homedir(), '.pi', 'agent', CONFIG_FILENAME)
  const projectPath = join(process.cwd(), '.pi', CONFIG_FILENAME)

  const readConfig = (filePath: string): RouterConfig | null => {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      return normalizeConfig(raw)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') return null
      throw new Error(`Config error in ${filePath}: ${(err as Error).message}`)
    }
  }

  const globalConfig = readConfig(globalPath) ?? { models: {} }
  const projectConfig = readConfig(projectPath) ?? { models: {} }

  return {
    models: { ...globalConfig.models, ...projectConfig.models },
  }
}

export const normalizeConfig = (raw: unknown): RouterConfig => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Config must be a non-null object')
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.models !== 'object' || obj.models === null) {
    throw new Error('Config must contain a "models" object')
  }

  const models: Record<string, CustomModelConfig> = {}

  for (const [key, value] of Object.entries(obj.models)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Model "${key}" must be an object`)
    }

    const entry = value as Record<string, unknown>

    if (!Array.isArray(entry.models)) {
      throw new Error(`Model "${key}" must have a "models" array`)
    }

    const modelRefs: string[] = []
    for (const ref of entry.models) {
      if (typeof ref !== 'string') {
        throw new Error(`Model "${key}" "models" entries must be strings`)
      }
      modelRefs.push(ref)
    }

    const config: CustomModelConfig = { models: modelRefs }

    if (entry.thinking !== undefined) {
      if (typeof entry.thinking !== 'string') {
        throw new Error(`Model "${key}" "thinking" must be a string`)
      }
      config.thinking = entry.thinking as ThinkingLevel
    }

    models[key] = config
  }

  const result: RouterConfig = { models }

  if (obj.providers !== undefined) {
    result.providers = normalizeProviders(obj.providers)
  }

  if (obj.rateLimitCooldownMs !== undefined) {
    if (typeof obj.rateLimitCooldownMs !== 'number' || obj.rateLimitCooldownMs < 0) {
      throw new Error('rateLimitCooldownMs must be a non-negative number')
    }
    result.rateLimitCooldownMs = obj.rateLimitCooldownMs
  }

  return result
}

const normalizeProviders = (
  raw: unknown,
): Record<string, CustomProviderEntry> => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Config "providers" must be a non-null object')
  }

  const providers: Record<string, CustomProviderEntry> = {}

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Provider "${name}" must be an object`)
    }

    const entry = value as Record<string, unknown>

    if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) {
      throw new Error(`Provider "${name}" must have a non-empty "baseUrl" string`)
    }

    if (typeof entry.apiKey !== 'string' || !entry.apiKey) {
      throw new Error(`Provider "${name}" must have a non-empty "apiKey" string`)
    }

    if (typeof entry.api !== 'string' || !entry.api) {
      throw new Error(`Provider "${name}" must have a non-empty "api" string`)
    }

    if (!Array.isArray(entry.models)) {
      throw new Error(`Provider "${name}" must have a "models" array`)
    }

    const models: CustomProviderEntry['models'] = []
    for (const [i, m] of entry.models.entries()) {
      if (typeof m !== 'object' || m === null) {
        throw new Error(`Provider "${name}" models[${i}] must be an object`)
      }
      const model = m as Record<string, unknown>
      if (typeof model.id !== 'string' || !model.id) {
        throw new Error(`Provider "${name}" models[${i}] must have a non-empty "id" string`)
      }
      models.push(model as unknown as CustomProviderEntry['models'][number])
    }

    const provider: CustomProviderEntry = {
      managed: entry.managed !== false,
      baseUrl: entry.baseUrl as string,
      apiKey: entry.apiKey as string,
      api: entry.api as string,
      models,
    }

    if (entry.authHeader !== undefined) {
      provider.authHeader = Boolean(entry.authHeader)
    }
    if (entry.headers !== undefined) {
      if (typeof entry.headers !== 'object' || entry.headers === null) {
        throw new Error(`Provider "${name}" "headers" must be an object`)
      }
      provider.headers = entry.headers as Record<string, string>
    }
    if (entry.compat !== undefined) {
      if (typeof entry.compat !== 'object' || entry.compat === null) {
        throw new Error(`Provider "${name}" "compat" must be an object`)
      }
      provider.compat = entry.compat as Record<string, unknown>
    }

    providers[name] = provider
  }

  return providers
}

export const getMaxThinkingLevel = (
  model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> | null },
): ThinkingLevel => {
  if (!model.reasoning) return 'off'
  if (!model.thinkingLevelMap) return 'high'

  for (const level of CONFIG_LEVELS) {
    const val = model.thinkingLevelMap[level]
    if (val != null) return level
  }

  return 'off'
}

export const contextHasImage = (
  context: { messages?: Array<{ content?: unknown }> },
): boolean => {
  if (!context.messages) return false

  for (const msg of context.messages) {
    const content = msg.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const obj = block as Record<string, unknown>
      if (obj.type === 'image') return true
      if (typeof obj.mimeType === 'string' && obj.mimeType.startsWith('image/')) return true
    }
  }

  return false
}

export const resolveModelRef = (
  ref: string,
  _modelRegistry?: { find?: (provider: string, modelId: string) => unknown } | null,
): { provider: string; modelId: string } | null => {
  const slashIdx = ref.indexOf('/')
  if (slashIdx <= 0 || slashIdx >= ref.length - 1) return null

  const provider = ref.slice(0, slashIdx)
  const modelId = ref.slice(slashIdx + 1)
  if (!provider || !modelId) return null

  return { provider, modelId }
}

// ---------------------------------------------------------------------------
// Separate configs (for commands that need to know which scope to write to)
// ---------------------------------------------------------------------------

export const loadSeparateConfigs = (): {
  global: RouterConfig
  project: RouterConfig
} => {
  const globalPath = join(homedir(), '.pi', 'agent', CONFIG_FILENAME)
  const projectPath = join(process.cwd(), '.pi', CONFIG_FILENAME)

  const readConfig = (filePath: string): RouterConfig | null => {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      return normalizeConfig(raw)
    } catch {
      return null
    }
  }

  return {
    global: readConfig(globalPath) ?? { models: {} },
    project: readConfig(projectPath) ?? { models: {} },
  }
}

export type ModelSource = 'global' | 'project' | 'both' | 'none'

export const getModelSource = (
  name: string,
  global: RouterConfig,
  project: RouterConfig,
): ModelSource => {
  const inGlobal = name in global.models
  const inProject = name in project.models
  if (inGlobal && inProject) return 'both'
  if (inGlobal) return 'global'
  if (inProject) return 'project'
  return 'none'
}
