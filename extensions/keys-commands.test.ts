import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ModelKeyPool } from './key-pool'
import {
  handleKeysCommand,
  formatPoolStatus,
  formatFooterStatus,
  testKey,
} from './keys-commands'
import type { KeyPoolConfig } from './types'

// ---------------------------------------------------------------------------
// Mock ctx.ui helpers
// ---------------------------------------------------------------------------

function mockCtx() {
  return {
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
    },
  }
}

// ---------------------------------------------------------------------------
// Cycle 1: /router keys — shows submenu with options
// ---------------------------------------------------------------------------
describe('Cycle 1: /router keys submenu', () => {
  it('/router keys without args shows available subcommands', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    await handleKeysCommand('', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('/router keys')
    expect(msg).toContain('status')
    expect(msg).toContain('reload')
    expect(msg).toContain('add')
    expect(msg).toContain('remove')
    expect(msg).toContain('clearcache')
    expect(msg).toContain('help')
  })

  it('/router keys help also shows subcommands', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    await handleKeysCommand('help', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('status')
    expect(msg).toContain('reload')
  })
})

// ---------------------------------------------------------------------------
// Cycle 2: /router keys status — displays pools with health overview
// ---------------------------------------------------------------------------
describe('Cycle 2: /router keys status overview', () => {
  it('shows pool overview with health counts', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-k1', 'sk-k2', 'sk-k3'] },
      },
    })
    // Mark one key as cooldown
    keyPool.markFailed('openrouter', 'sk-k3', new Error('429 Too Many Requests'))

    await handleKeysCommand('status', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('openrouter')
    expect(msg).toContain('3 keys')
    expect(msg).toContain('2✓')
    expect(msg).toContain('1⏳')
    expect(msg).toContain('round-robin')
  })

  it('shows empty state when no pools configured', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    await handleKeysCommand('status', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('No keys')
  })

  it('handles multiple pools', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-k1'] },
        anthropic: { keys: ['sk-a1', 'sk-a2'] },
      },
    })

    await handleKeysCommand('status', ctx, keyPool, vi.fn())

    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('openrouter')
    expect(msg).toContain('anthropic')
  })
})

// ---------------------------------------------------------------------------
// Cycle 3: /router keys status — detailed per-key info
// ---------------------------------------------------------------------------
describe('Cycle 3: per-key detail in status', () => {
  it('shows per-key health status', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-k1', 'sk-k2'] },
      },
    })
    keyPool.markFailed('openrouter', 'sk-k2', new Error('401 Unauthorized'))

    await handleKeysCommand('status', ctx, keyPool, vi.fn())

    const msg = ctx.ui.notify.mock.calls[0][0] as string
    // Pool overview
    expect(msg).toContain('openrouter')
    expect(msg).toContain('2 keys')
    // Per-key detail
    expect(msg).toContain('sk-k1')
    expect(msg).toContain('healthy')
    expect(msg).toContain('sk-k2')
    expect(msg).toContain('dead')
  })

  it('shows truncated key preview', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] },
      },
    })

    await handleKeysCommand('status', ctx, keyPool, vi.fn())

    const msg = ctx.ui.notify.mock.calls[0][0] as string
    // Key should be truncated to first 12 chars
    expect(msg).toContain('sk-or-v1-aaa')
    expect(msg).not.toContain('sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })
})

// ---------------------------------------------------------------------------
// Cycle 4: /router keys reload — triggers config reload (observable)
// ---------------------------------------------------------------------------
describe('Cycle 4: /router keys reload', () => {
  it('reloads keys config and updates pool', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-old'] },
      },
    })

    const newConfig: KeyPoolConfig = {
      providers: {
        openrouter: { keys: ['sk-new'] },
      },
    }
    const configLoader = vi.fn().mockReturnValue(newConfig)

    await handleKeysCommand('reload', ctx, keyPool, configLoader)

    // After reload, getNextKey should return the new key
    const result = keyPool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-new', headers: {} })
    expect(result).not.toEqual({ apiKey: 'sk-old', headers: {} })
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('reloaded'),
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// Cycle 5: /router keys clearcache — resets all state (observable)
// ---------------------------------------------------------------------------
describe('Cycle 5: /router keys clearcache', () => {
  it('clears cooldown state, making keys available again', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-k1'] },
      },
    })
    // Mark key as cooldown
    keyPool.markFailed('openrouter', 'sk-k1', new Error('429 Too Many Requests'))
    expect(keyPool.getNextKey('openrouter')).toBeNull()

    await handleKeysCommand('clearcache', ctx, keyPool, vi.fn())

    // After clearcache, key should be available again
    const result = keyPool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-k1', headers: {} })
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('cleared'),
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// Cycle 6: /router keys add — adds key (observable)
// ---------------------------------------------------------------------------
describe('Cycle 6: /router keys add', () => {
  it('prompts for provider and key, then makes new key usable', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    // Mock user input: provider name and key
    ctx.ui.input
      .mockResolvedValueOnce('openrouter')  // provider
      .mockResolvedValueOnce('sk-newkey')   // key value

    let savedConfig: KeyPoolConfig | undefined
    const configLoader = vi.fn(() => savedConfig ?? { providers: {} })
    const configWriter = vi.fn((cfg: KeyPoolConfig) => {
      savedConfig = cfg
    })

    await handleKeysCommand('add', ctx, keyPool, configLoader, configWriter)

    // Should have prompted twice
    expect(ctx.ui.input).toHaveBeenCalledTimes(2)
    expect(ctx.ui.input).toHaveBeenCalledWith(
      expect.stringContaining('provider'),
      expect.any(String),
    )

    // Config should have been written
    expect(configWriter).toHaveBeenCalledTimes(1)
    const written = configWriter.mock.calls[0][0] as KeyPoolConfig
    expect(written.providers['openrouter']).toBeDefined()
    expect(written.providers['openrouter'].keys).toContain('sk-newkey')

    // Pool should have been reloaded — new key is usable
    expect(keyPool.getNextKey('openrouter')).toEqual({
      apiKey: 'sk-newkey',
      headers: {},
    })

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('added'),
      expect.any(String),
    )
  })

  it('accepts provider as argument', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    ctx.ui.input.mockResolvedValueOnce('sk-argkey')

    let savedConfig: KeyPoolConfig | undefined
    const configLoader = vi.fn(() => savedConfig ?? { providers: {} })
    const configWriter = vi.fn((cfg: KeyPoolConfig) => {
      savedConfig = cfg
    })

    await handleKeysCommand('add openrouter', ctx, keyPool, configLoader, configWriter)

    // Should have prompted only once (for the key value)
    expect(ctx.ui.input).toHaveBeenCalledTimes(1)
    expect(ctx.ui.input).toHaveBeenCalledWith(
      expect.stringContaining('key'),
      expect.any(String),
    )

    expect(keyPool.getNextKey('openrouter')).toEqual({
      apiKey: 'sk-argkey',
      headers: {},
    })
  })

  it('cancels when user cancels provider input', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    ctx.ui.input.mockResolvedValueOnce(null) // cancel provider input
    const configWriter = vi.fn()

    await handleKeysCommand('add', ctx, keyPool, vi.fn(), configWriter)

    expect(configWriter).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('cancel'),
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// Cycle 7: /router keys remove — removes key (observable)
// ---------------------------------------------------------------------------
describe('Cycle 7: /router keys remove', () => {
  it('shows key selector and removes selected key', async () => {
    const ctx = mockCtx() as any
    const startingConfig: KeyPoolConfig = {
      providers: {
        openrouter: { keys: ['sk-k1', 'sk-k2'] },
      },
    }
    const keyPool = new ModelKeyPool(startingConfig)

    // Mock select to return the key to remove
    ctx.ui.select.mockResolvedValueOnce('sk-k1')

    let savedConfig: KeyPoolConfig | undefined = { ...startingConfig }
    const configLoader = vi.fn(() => savedConfig ?? { providers: {} })
    const configWriter = vi.fn((cfg: KeyPoolConfig) => {
      savedConfig = cfg
    })

    await handleKeysCommand('remove openrouter', ctx, keyPool, configLoader, configWriter)

    // Should have shown key selector
    expect(ctx.ui.select).toHaveBeenCalledTimes(1)
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining('Pilih key'),
      expect.arrayContaining(['sk-k1', 'sk-k2']),
    )

    // Config should be updated without removed key
    expect(configWriter).toHaveBeenCalledTimes(1)
    const written = configWriter.mock.calls[0][0] as KeyPoolConfig
    expect(written.providers['openrouter'].keys).toEqual(['sk-k2'])
    expect(written.providers['openrouter'].keys).not.toContain('sk-k1')

    // After reload, removed key should not be returned
    expect(keyPool.getNextKey('openrouter')).toEqual({
      apiKey: 'sk-k2',
      headers: {},
    })

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('removed'),
      expect.any(String),
    )
  })

  it('prompts for provider if not provided as argument', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    ctx.ui.input.mockResolvedValueOnce(null) // cancel provider input
    const configWriter = vi.fn()

    await handleKeysCommand('remove', ctx, keyPool, vi.fn(), configWriter)

    expect(ctx.ui.input).toHaveBeenCalledWith(
      expect.stringContaining('provider'),
      expect.any(String),
    )
    expect(configWriter).not.toHaveBeenCalled()
  })

  it('cancels when user cancels key selection', async () => {
    const ctx = mockCtx() as any
    const startingConfig: KeyPoolConfig = {
      providers: {
        openrouter: { keys: ['sk-k1'] },
      },
    }
    const keyPool = new ModelKeyPool(startingConfig)

    ctx.ui.select.mockResolvedValueOnce(null) // cancel selection

    let savedConfig: KeyPoolConfig = { ...startingConfig }
    const configLoader = vi.fn(() => savedConfig)
    const configWriter = vi.fn()

    await handleKeysCommand('remove openrouter', ctx, keyPool, configLoader, configWriter)

    expect(configWriter).not.toHaveBeenCalled()
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('cancel'),
      expect.any(String),
    )
  })
})

// ---------------------------------------------------------------------------
// Helper: formatPoolStatus
// ---------------------------------------------------------------------------
describe('formatPoolStatus', () => {
  it('formats healthy-only pool', () => {
    const status = {
      provider: 'openrouter',
      keys: ['k1', 'k2', 'k3'],
      health: { k1: 'healthy' as const, k2: 'healthy' as const, k3: 'healthy' as const },
      strategy: 'round-robin' as const,
    }
    expect(formatPoolStatus(status)).toBe('openrouter — 3 keys (3✓) | round-robin')
  })

  it('formats mixed health pool', () => {
    const status = {
      provider: 'openrouter',
      keys: ['k1', 'k2', 'k3'],
      health: { k1: 'healthy' as const, k2: 'cooldown' as const, k3: 'dead' as const },
      strategy: 'fallback' as const,
    }
    expect(formatPoolStatus(status)).toBe('openrouter — 3 keys (1✓ 1⏳ 1✗) | fallback')
  })

  it('formats empty pool', () => {
    const status = {
      provider: 'openrouter',
      keys: [],
      health: {},
      strategy: 'round-robin' as const,
    }
    expect(formatPoolStatus(status)).toBe('openrouter — 0 keys | round-robin')
  })
})

// ---------------------------------------------------------------------------
// Helper: formatFooterStatus
// ---------------------------------------------------------------------------
describe('formatFooterStatus', () => {
  it('formats with health counts when keys exist', () => {
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['k1', 'k2', 'k3', 'k4'] },
      },
    })
    keyPool.markFailed('openrouter', 'k3', new Error('429'))
    keyPool.markFailed('openrouter', 'k4', new Error('401'))

    const result = formatFooterStatus(keyPool)
    expect(result).toBe('🔑 OR:4 (2✓ 1⏳ 1✗)')
  })

  it('returns no-keys message when no pools configured', () => {
    const keyPool = new ModelKeyPool({ providers: {} })
    expect(formatFooterStatus(keyPool)).toBe('🔑 (no keys configured)')
  })

  it('abbreviates provider name to first word', () => {
    const keyPool = new ModelKeyPool({
      providers: {
        'open-router': { keys: ['k1'] },
      },
    })
    expect(formatFooterStatus(keyPool)).toContain('OR:1')
  })

  it('handles null keyPool', () => {
    expect(formatFooterStatus(null)).toBe('🔑 (no keys configured)')
  })
})

// ---------------------------------------------------------------------------
// Cycle 8: Footer — key pool summary
// ---------------------------------------------------------------------------
describe('Cycle 8: Footer status summary', () => {
  it('formatFooterStatus shows correct summary for mixed health', () => {
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['k1', 'k2', 'k3'] },
      },
    })
    keyPool.markFailed('openrouter', 'k2', new Error('429'))
    keyPool.markFailed('openrouter', 'k3', new Error('401'))

    const result = formatFooterStatus(keyPool)
    expect(result).toBe('🔑 OR:3 (1✓ 1⏳ 1✗)')
  })
})

// ---------------------------------------------------------------------------
// Cycle 9: Footer — no keys configured
// ---------------------------------------------------------------------------
describe('Cycle 9: Footer no keys', () => {
  it('formatFooterStatus returns no-keys message for empty pool', () => {
    const keyPool = new ModelKeyPool({ providers: {} })
    expect(formatFooterStatus(keyPool)).toBe('🔑 (no keys configured)')
  })

  it('formatFooterStatus returns no-keys message for null pool', () => {
    const keyPool = new ModelKeyPool({ providers: {} })
    expect(formatFooterStatus(null)).toBe('🔑 (no keys configured)')
  })
})

// ---------------------------------------------------------------------------
// Slice 4: Validation + Edge Case Polish
// ---------------------------------------------------------------------------

describe('Slice 4: Cycle 1 — /router keys test <provider>', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows passing keys with ✓ and failing keys with ✗ and error', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-or-v1-passkey', 'sk-or-v1-failkey'] },
      },
    })

    // First fetch succeeds, second fetch fails with 401
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }))

    await handleKeysCommand('test openrouter', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
    const msg = ctx.ui.notify.mock.calls[0][0] as string
    expect(msg).toContain('✓')
    expect(msg).toContain('✗')
    // Keys are truncated to 12 chars for display
    expect(msg).toContain('sk-or-v1-pas')
    expect(msg).toContain('sk-or-v1-fai')
    expect(msg).toContain('401 Unauthorized')
  })

  it('shows warning when provider not found', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({ providers: {} })

    await handleKeysCommand('test unknown', ctx, keyPool, vi.fn())

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('No keys'),
      'warning',
    )
  })
})

describe('Slice 4: Cycle 2 — test updates health', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks key healthy after successful test', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })
    // Pre-mark as failed so health is not healthy
    keyPool.markFailed('openrouter', 'sk-key1', '429')
    const before = keyPool.getStatus()[0]
    expect(before.health['sk-key1']).toBe('cooldown')

    // Test succeeds
    vi.mocked(fetch).mockResolvedValueOnce(new Response('ok', { status: 200 }))

    await handleKeysCommand('test openrouter', ctx, keyPool, vi.fn())

    // Health should be restored
    const after = keyPool.getStatus()[0]
    expect(after.health['sk-key1']).toBe('healthy')
    expect(after.failures['sk-key1']).toBe(0)
  })

  it('marks key dead after failed test with 401', async () => {
    const ctx = mockCtx() as any
    const keyPool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-key1'] },
      },
    })

    // Test fails with 401
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    )

    await handleKeysCommand('test openrouter', ctx, keyPool, vi.fn())

    const after = keyPool.getStatus()[0]
    expect(after.health['sk-key1']).toBe('dead')
    expect(after.failures['sk-key1']).toBe(1)
  })
})

describe('Slice 4: Cycle 3 — markFailed defensive vs non-Error', () => {
  it('handles string error without crashing', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })

    // Must not throw
    expect(() => {
      pool.markFailed('test', 'key1', 'string error message')
    }).not.toThrow()

    const status = pool.getStatus()[0]
    // Should be classified as cooldown (default for unrecognized errors)
    expect(status.health['key1']).toBe('cooldown')
    expect(status.failures['key1']).toBe(1)
  })

  it('handles number error without crashing', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })

    expect(() => {
      pool.markFailed('test', 'key1', 404)
    }).not.toThrow()

    const status = pool.getStatus()[0]
    expect(status.failures['key1']).toBe(1)
  })

  it('still handles Error objects correctly', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1'] },
      },
    })

    pool.markFailed('test', 'key1', new Error('401 Unauthorized'))

    const status = pool.getStatus()[0]
    expect(status.health['key1']).toBe('dead')
    expect(status.failures['key1']).toBe(1)
  })
})

describe('Slice 4: Cycle 4 — staggered recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recovers keys one by one as staggered until timestamps expire', () => {
    const pool = new ModelKeyPool({
      providers: {
        test: { keys: ['key1', 'key2', 'key3'] },
      },
    })

    // Fail all 3 keys — each with a different error to get staggered recovery
    // All start at time 0
    pool.markFailed('test', 'key1', new Error('429 Too Many Requests'))  // cooldown 60s
    pool.markFailed('test', 'key2', new Error('502 Bad Gateway'))       // cooldown 60s
    pool.markFailed('test', 'key3', new Error('401 Unauthorized'))      // dead 300s

    // All keys should be unavailable
    expect(pool.getNextKey('test')).toBeNull()

    // Advance just past key1 and key2's cooldown (60s)
    vi.advanceTimersByTime(60_001)
    // key1 and key2 should recover now; key3 still dead
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key1', headers: {} })
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key2', headers: {} })
    // Only 2 healthy keys, so round-robin cycles between them
    // key3 is still dead

    // Advance past key3's dead period
    vi.advanceTimersByTime(240_001)  // total 300_002 since start
    // Now all 3 keys recover; round-robin picks in order
    expect(pool.getNextKey('test')).toEqual({ apiKey: 'key3', headers: {} })
  })
})

describe('Slice 4: Cycle 5 — reload atomic swap', () => {
  it('reload assigns new Map — old providers gone, new providers available', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-old'] },
      },
    })

    // Old provider works before reload
    expect(pool.getNextKey('openrouter')).toEqual({ apiKey: 'sk-old', headers: {} })

    // Capture status before reload to prove state is observable
    const beforeStatus = pool.getStatus()
    expect(beforeStatus).toHaveLength(1)
    expect(beforeStatus[0].provider).toBe('openrouter')

    // Reload with completely different config
    pool.reload({
      providers: {
        anthropic: { keys: ['sk-new'] },
      },
    })

    // Old provider is gone
    expect(pool.getNextKey('openrouter')).toBeNull()

    // New provider works
    expect(pool.getNextKey('anthropic')).toEqual({ apiKey: 'sk-new', headers: {} })

    // Status shows only new provider
    const afterStatus = pool.getStatus()
    expect(afterStatus).toHaveLength(1)
    expect(afterStatus[0].provider).toBe('anthropic')
  })

  it('reload replaces Map reference (atomic swap)', () => {
    const pool = new ModelKeyPool({
      providers: {
        openrouter: { keys: ['sk-old'] },
      },
    })

    // Capture the old pool's internal state before reload
    const beforeStatus = pool.getStatus()

    pool.reload({
      providers: {
        openrouter: { keys: ['sk-replaced'] },
      },
    })

    // After reload, same provider returns new key
    const result = pool.getNextKey('openrouter')
    expect(result).toEqual({ apiKey: 'sk-replaced', headers: {} })
    expect(result).not.toEqual({ apiKey: 'sk-old', headers: {} })

    // The beforeStatus snapshot is still valid (old Map not mutated)
    // This proves the old Map reference is intact
    expect(beforeStatus[0].keys).toEqual(['sk-old'])
  })
})
