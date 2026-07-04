import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ModelKeyPool } from './key-pool'

// ---------------------------------------------------------------------------
// Cycle 1: ModelKeyPool can hold 1 provider with 1 key and return it
// ---------------------------------------------------------------------------
describe('ModelKeyPool', () => {
  it('holds 1 provider with 1 key and returns it', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-key1', headers: {} })
  })

  // -----------------------------------------------------------------------
  // Cycle 2: getNextKey returns null for unknown provider
  // -----------------------------------------------------------------------
  it('returns null for unknown provider', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    expect(pool.getNextKey('nope')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Cycle 3: Custom headers returned in getNextKey
  // -----------------------------------------------------------------------
  it('returns custom headers from provider config', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: {
          keys: ['sk-key1'],
          headers: { 'X-Title': 'pi', 'X-Custom': 'test' },
        },
      },
    })
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({
      apiKey: 'sk-key1',
      headers: { 'X-Title': 'pi', 'X-Custom': 'test' },
    })
  })

  // -----------------------------------------------------------------------
  // Cycle 4: markFailed with 429 makes getNextKey return null
  // -----------------------------------------------------------------------
  it('returns null after markFailed with 429 (rate-limit cooldown)', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('429 Too Many Requests'))
    expect(pool.getNextKey('openrouter')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Cycle 5: markFailed with 401/403 makes getNextKey skip that key
  // -----------------------------------------------------------------------
  it('skips dead key after 401 and returns the other key', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1', 'sk-key2'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('401 Unauthorized'))
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-key2', headers: {} })
  })

  it('skips dead key after 403 and returns the other key', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1', 'sk-key2'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('403 Forbidden'))
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-key2', headers: {} })
  })

  // -----------------------------------------------------------------------
  // Cycle 6: markFailed with 5xx makes getNextKey return null
  // -----------------------------------------------------------------------
  it('returns null after markFailed with 502 (server error)', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('502 Bad Gateway'))
    expect(pool.getNextKey('openrouter')).toBeNull()
  })

  it('returns null after markFailed with 503 (server error)', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('503 Service Unavailable'))
    expect(pool.getNextKey('openrouter')).toBeNull()
  })

  it('returns null after markFailed with 504 (server error)', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('504 Gateway Timeout'))
    expect(pool.getNextKey('openrouter')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Cycle 7: markSuccess makes getNextKey return key again
  // -----------------------------------------------------------------------
  it('restores key after markSuccess following markFailed', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('429'))
    expect(pool.getNextKey('openrouter')).toBeNull()
    pool.markSuccess('openrouter', 'sk-key1')
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-key1', headers: {} })
  })

  // -----------------------------------------------------------------------
  // Cycle 8: Lazy health recovery — cooldown expires
  // -----------------------------------------------------------------------
  describe('lazy recovery', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('recovers cooldown key when until has expired', () => {
      const pool = new ModelKeyPool({
        providers: {
          openrouter: { keys: ['sk-key1'] },
        },
      })
      pool.markFailed('openrouter', 'sk-key1', new Error('429 Too Many Requests'))
      // After markFailed, key is in cooldown → getNextKey returns null
      expect(pool.getNextKey('openrouter')).toBeNull()
      // Advance time past the cooldown period (60s default + 1ms buffer)
      vi.advanceTimersByTime(60_001)
      // Lazy recovery: getNextKey should return the key again
      const result = pool.getNextKey('openrouter')
      expect(result).toEqual({ apiKey: 'sk-key1', headers: {} })
    })

    // -----------------------------------------------------------------------
    // Cycle 9: Lazy health recovery — dead expires
    // -----------------------------------------------------------------------
    it('recovers dead key when until has expired', () => {
      const pool = new ModelKeyPool({
        providers: {
          openrouter: { keys: ['sk-key1'] },
        },
      })
      pool.markFailed('openrouter', 'sk-key1', new Error('401 Unauthorized'))
      // After markFailed, key is dead → getNextKey returns null
      expect(pool.getNextKey('openrouter')).toBeNull()
      // Advance time past the dead period (300s default + 1ms buffer)
      vi.advanceTimersByTime(300_001)
      // Lazy recovery: getNextKey should return the key again
      const result = pool.getNextKey('openrouter')
      expect(result).toEqual({ apiKey: 'sk-key1', headers: {} })
    })
  })

  // -----------------------------------------------------------------------
  // Cycle 10: getStatus returns pool overview
  // -----------------------------------------------------------------------
  it('returns status overview of all pools', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: {
          keys: ['sk-key1', 'sk-key2'],
          headers: { 'X-Title': 'pi' },
        },
        anthropic: { keys: ['sk-anthropic'] },
      },
    })
    const status = pool.getStatus()
    expect(status).toHaveLength(2)

    const openrouterStatus = status.find((s) => s.provider === 'openrouter')
    expect(openrouterStatus).toBeDefined()
    expect(openrouterStatus!.keys).toEqual(['sk-key1', 'sk-key2'])
    expect(openrouterStatus!.health).toEqual({
      'sk-key1': 'healthy',
      'sk-key2': 'healthy',
    })
    expect(openrouterStatus!.strategy).toBe('round-robin')

    const anthropicStatus = status.find((s) => s.provider === 'anthropic')
    expect(anthropicStatus).toBeDefined()
    expect(anthropicStatus!.keys).toEqual(['sk-anthropic'])
  })

  it('getStatus reflects markFailed state', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1', 'sk-key2'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('401 Unauthorized'))
    const status = pool.getStatus()
    const orStatus = status.find((s) => s.provider === 'openrouter')
    expect(orStatus!.health['sk-key1']).toBe('dead')
    expect(orStatus!.health['sk-key2']).toBe('healthy')
  })

  // -----------------------------------------------------------------------
  // Cycle 11: reload atomically replaces pools
  // -----------------------------------------------------------------------
  it('reload atomically replaces pools', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    expect(pool.getNextKey('openrouter')).toEqual({
      apiKey: 'sk-key1',
      headers: {},
    })

    pool.reload({
      providers: {
        anthropic: { keys: ['sk-anthropic'] },
      },
    })
    // Old provider should be gone
    expect(pool.getNextKey('openrouter')).toBeNull()
    // New provider should work
    expect(pool.getNextKey('anthropic')).toEqual({
      apiKey: 'sk-anthropic',
      headers: {},
    })
  })

  // -----------------------------------------------------------------------
  // Cycle 12: clear resets all state
  // -----------------------------------------------------------------------
  it('clear resets all keys to healthy', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1', 'sk-key2'] },
      },
    })
    pool.markFailed('openrouter', 'sk-key1', new Error('401 Unauthorized'))
    pool.markFailed('openrouter', 'sk-key2', new Error('502 Bad Gateway'))
    expect(pool.getNextKey('openrouter')).toBeNull()

    pool.clear()
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-key1', headers: {} })
  })
})

// ---------------------------------------------------------------------------
// Slice 2: Multi-key rotation + health tracking
// ---------------------------------------------------------------------------

describe('round-robin rotation', () => {
  // Cycle 1: Round-robin with 3 healthy keys cycles correctly
  it('cycles through 3 healthy keys in order', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'] },
      },
    })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key2', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key3', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key2', headers: {} })
  })

  // Cycle 2: Round-robin skips cooldown keys
  it('skips cooldown key and continues round-robin', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'] },
      },
    })
    // Establish initial sequence: key1, key2, key3
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key2', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key3', headers: {} })

    // key2 goes into cooldown
    pool.markFailed('test', 'key2', new Error('429 Too Many Requests'))

    // Should skip key2: key1, key3, key1, key3
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key3', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key3', headers: {} })
  })

  // Cycle 3: Round-robin all cooldown → null
  it('returns null when all keys are in cooldown', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'] },
      },
    })
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key2', new Error('429'))
    pool.markFailed('test', 'key3', new Error('429'))
    expect(pool.getNextKey('test')).toBeNull()
  })
})

describe('fallback strategy', () => {
  // Cycle 4: Fallback — returns first healthy key
  it('returns first healthy key when some are dead', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'], strategy: 'fallback' },
      },
    })
    pool.markFailed('test', 'key1', new Error('401 Unauthorized'))
    // key1 dead, key2 is first healthy
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key2', headers: {} })
  })

  // Cycle 5: Fallback — all dead → null
  it('returns null when all keys are dead or cooldown', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'], strategy: 'fallback' },
      },
    })
    pool.markFailed('test', 'key1', new Error('401'))
    pool.markFailed('test', 'key2', new Error('401'))
    pool.markFailed('test', 'key3', new Error('401'))
    expect(pool.getNextKey('test')).toBeNull()
  })
})

describe('health tracking', () => {
  // Cycle 6: markFailed increments failures counter
  it('increments failures on repeated markFailed calls', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })
    pool.markFailed('test', 'key1', new Error('429'))
    expect(pool.getStatus()[0].failures['key1']).toBe(1)
    pool.markFailed('test', 'key1', new Error('429'))
    expect(pool.getStatus()[0].failures['key1']).toBe(2)
    pool.markFailed('test', 'key1', new Error('429'))
    expect(pool.getStatus()[0].failures['key1']).toBe(3)
  })

  // Cycle 7: getNextKey tracks usageCount and lastUsed
  it('tracks usageCount and lastUsed via getStatus', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })
    pool.getNextKey('test')
    pool.getNextKey('test')
    pool.getNextKey('test')

    const status = pool.getStatus()[0]
    expect(status.usageCount['key1']).toBe(3)
    expect(status.lastUsed['key1']).toBeGreaterThan(0)
  })

  // Cycle 8: Error rate — consecutive failures >= 5 → dead
  it('marks key as dead after 5 consecutive failures', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))

    const status = pool.getStatus()[0]
    expect(status.health['key1']).toBe('dead')
    expect(status.failures['key1']).toBe(5)
    expect(pool.getNextKey('test')).toBeNull()
  })

  // Cycle 9: Error rate — success resets failure count
  it('resets failure count after markSuccess', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    pool.markFailed('test', 'key1', new Error('429'))
    expect(pool.getStatus()[0].failures['key1']).toBe(4)

    pool.markSuccess('test', 'key1')
    const status = pool.getStatus()[0]
    expect(status.failures['key1']).toBe(0)
    expect(status.health['key1']).toBe('healthy')
  })
})
