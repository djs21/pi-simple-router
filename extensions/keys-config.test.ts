import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KeyPoolConfig } from './types'

// Hoisted mock variables — these are available inside vi.mock factory
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockReadFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

import { normalizeKeysConfig, loadKeysConfig } from './keys-config'

// ---------------------------------------------------------------------------
// Cycle 13: normalizeKeysConfig — valid input
// ---------------------------------------------------------------------------
describe('normalizeKeysConfig', () => {
  it('returns KeyPoolConfig for valid input with one provider', () => {
    const result = normalizeKeysConfig({
      providers: {
        p: { keys: ['k1'] },
      },
    })
    expect(result).toEqual({
      providers: {
        p: { keys: ['k1'], strategy: 'round-robin' },
      },
    } satisfies KeyPoolConfig)
  })

  // -----------------------------------------------------------------------
  // Cycle 14: normalizeKeysConfig — null input throws
  // -----------------------------------------------------------------------
  it('throws for null input', () => {
    expect(() => normalizeKeysConfig(null)).toThrow()
  })

  // -----------------------------------------------------------------------
  // Cycle 15: normalizeKeysConfig — missing providers throws
  // -----------------------------------------------------------------------
  it('throws for missing providers', () => {
    expect(() => normalizeKeysConfig({})).toThrow()
  })

  // -----------------------------------------------------------------------
  // Cycle 16: normalizeKeysConfig — keys not an array throws
  // -----------------------------------------------------------------------
  it('throws when keys is not an array', () => {
    expect(() =>
      normalizeKeysConfig({ providers: { p: { keys: 'not-an-array' } } }),
    ).toThrow()
  })

  // -----------------------------------------------------------------------
  // Cycle 17: normalizeKeysConfig — key not a string throws
  // -----------------------------------------------------------------------
  it('throws when a key is not a string', () => {
    expect(() =>
      normalizeKeysConfig({ providers: { p: { keys: [123] } } }),
    ).toThrow()
  })

  // -----------------------------------------------------------------------
  // Cycle 18: normalizeKeysConfig — strategy invalid throws
  // -----------------------------------------------------------------------
  it('throws for invalid strategy', () => {
    expect(() =>
      normalizeKeysConfig({
        providers: { p: { keys: ['k1'], strategy: 'invalid' } },
      }),
    ).toThrow()
  })

  // -----------------------------------------------------------------------
  // Cycle 19: normalizeKeysConfig — omitted strategy defaults to round-robin
  // -----------------------------------------------------------------------
  it('defaults to round-robin when strategy is omitted', () => {
    const result = normalizeKeysConfig({
      providers: { p: { keys: ['k1'] } },
    })
    expect(result.providers.p.strategy).toBe('round-robin')
  })
})

// ---------------------------------------------------------------------------
// Cycle 20: loadKeysConfig — no files exist
// ---------------------------------------------------------------------------
describe('loadKeysConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty providers when no files exist', () => {
    const result = loadKeysConfig()
    expect(result).toEqual({ providers: {} })
  })

  // -----------------------------------------------------------------------
  // Cycle 21: loadKeysConfig — merges global + project
  // -----------------------------------------------------------------------
  it('merges global and project configs', () => {
    mockExistsSync.mockReturnValue(true)

    mockReadFileSync.mockImplementation((path: string | URL) => {
      const pathStr = path.toString()
      if (pathStr.includes('.pi/agent')) {
        return JSON.stringify({
          providers: {
            openrouter: { keys: ['sk-global-or'] },
          },
        })
      }
      // Project config
      return JSON.stringify({
        providers: {
          anthropic: { keys: ['sk-project-ant'] },
          openrouter: { keys: ['sk-project-or'] },
        },
      })
    })

    const result = loadKeysConfig()
    // Project overrides global for same provider
    expect(result.providers.openrouter.keys).toEqual(['sk-project-or'])
    // Project-only provider added
    expect(result.providers.anthropic.keys).toEqual(['sk-project-ant'])
  })
})
