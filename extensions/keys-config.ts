import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { KeyPoolConfig, ProviderKeyConfig, RotationStrategy } from './types'

const VALID_STRATEGIES: RotationStrategy[] = ['round-robin', 'fallback']
const KEYS_CONFIG_FILENAME = 'router-keys.json'

// ---------------------------------------------------------------------------
// normalizeKeysConfig
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a raw key-pool config object.
 * Follows the same pattern as normalizeConfig in config.ts.
 */
export const normalizeKeysConfig = (raw: unknown): KeyPoolConfig => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Keys config must be a non-null object')
  }

  const obj = raw as Record<string, unknown>

  if (!obj.providers || typeof obj.providers !== 'object') {
    throw new Error('Keys config must contain a "providers" object')
  }

  const providers: Record<string, ProviderKeyConfig> = {}

  for (const [provider, value] of Object.entries(obj.providers)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Provider "${provider}" must be an object`)
    }

    const entry = value as Record<string, unknown>

    if (!Array.isArray(entry.keys)) {
      throw new Error(`Provider "${provider}" must have a "keys" array`)
    }

    const keys: string[] = []
    for (const key of entry.keys) {
      if (typeof key !== 'string') {
        throw new Error(
          `Provider "${provider}" key entries must be strings`,
        )
      }
      keys.push(key)
    }

    const config: ProviderKeyConfig = { keys }

    if (entry.headers !== undefined) {
      if (typeof entry.headers !== 'object' || entry.headers === null || Array.isArray(entry.headers)) {
        throw new Error(`Provider "${provider}" "headers" must be an object`)
      }
      config.headers = entry.headers as Record<string, string>
    }

    if (entry.strategy !== undefined) {
      if (!VALID_STRATEGIES.includes(entry.strategy as RotationStrategy)) {
        throw new Error(
          `Provider "${provider}" "strategy" must be one of: ${VALID_STRATEGIES.join(', ')}`,
        )
      }
      config.strategy = entry.strategy as RotationStrategy
    } else {
      config.strategy = 'round-robin'
    }

    providers[provider] = config
  }

  return { providers }
}

// ---------------------------------------------------------------------------
// loadKeysConfig
// ---------------------------------------------------------------------------

/**
 * Load and merge key pool config from global (~/.pi/agent/router-keys.json)
 * and project (.pi/router-keys.json) config files.
 *
 * Project overrides global for the same provider.
 */
export const loadKeysConfig = (): KeyPoolConfig => {
  const globalPath = join(homedir(), '.pi', 'agent', KEYS_CONFIG_FILENAME)
  const projectPath = join(process.cwd(), '.pi', KEYS_CONFIG_FILENAME)

  const readConfig = (filePath: string): KeyPoolConfig | null => {
    try {
      if (!existsSync(filePath)) return null
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      return normalizeKeysConfig(raw)
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOENT') return null
      throw new Error(`Keys config error in ${filePath}: ${(err as Error).message}`)
    }
  }

  const globalConfig = readConfig(globalPath) ?? { providers: {} }
  const projectConfig = readConfig(projectPath) ?? { providers: {} }

  return {
    providers: { ...globalConfig.providers, ...projectConfig.providers },
  }
}
