import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelKeyPool } from './key-pool'
import {
  handleKeysCommand,
  formatPoolStatus,
  formatFooterStatus,
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
    expect(formatFooterStatus(null)).toBe('🔑 (no keys configured)')
  })
})
