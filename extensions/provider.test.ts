import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RouterConfig } from './types'
import { PROVIDER_NAME, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants'

// ---------------------------------------------------------------------------
// Mock pi SDK modules — these are hoisted before any real imports.
// provider.ts imports streamSimple and createAssistantMessageEventStream
// at runtime; everything else from pi-ai is type-only.
// ---------------------------------------------------------------------------
vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', () => {
  // Track end promises per-stream so tests can await async IIFE completion
  const endResolveMap = new Map<symbol, () => void>()

  return {
    createAssistantMessageEventStream: vi.fn(() => {
      const id = Symbol()
      const endPromise = new Promise<void>(resolve => {
        endResolveMap.set(id, resolve)
      })

      const stream = {
        push: vi.fn(),
        end: vi.fn(() => {
          const resolve = endResolveMap.get(id)
          if (resolve) {
            endResolveMap.delete(id)
            setTimeout(resolve, 0)
          }
        }),
        /** @internal — tests await this to know when router IIFE completed */
        [Symbol.asyncIterator]: vi.fn(),
      }

      // Attach endPromise so tests can await it
      ;(stream as any)._endPromise = endPromise

      return stream
    }),
  }
})

// Module under test — must come after vi.mock calls
import { registerRouterProvider } from './provider'
import { clearRateLimits, getActiveRateLimits } from './rate-limit-tracker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock model resembling what ModelRegistry.find returns. */
function mockModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gpt-4',
    provider: 'openai',
    name: 'GPT-4',
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('registerRouterProvider', () => {
  const mockApi = {
    registerProvider: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the router provider with correct name', () => {
    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    expect(mockApi.registerProvider).toHaveBeenCalledTimes(1)
    expect(mockApi.registerProvider).toHaveBeenCalledWith(
      PROVIDER_NAME,
      expect.objectContaining({
        baseUrl: 'http://router.local',
        apiKey: 'pi-model-router',
        api: 'router-local-api',
        models: expect.any(Array),
        streamSimple: expect.any(Function),
      }),
    )
  })

  it('builds a model entry from a single ref', () => {
    const config: RouterConfig = {
      models: { thinker: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel({ reasoning: true })),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models).toHaveLength(1)
    expect(providerCfg.models[0]).toMatchObject({
      id: 'thinker',
      name: 'Router thinker',
      reasoning: true,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('propagates image support when underlying model supports images', () => {
    const config: RouterConfig = {
      models: { vision: { models: ['openai/gpt-4-vision'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(
        mockModel({ input: ['text', 'image'] }),
      ),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].input).toContain('image')
  })

  it('aggregates max contextWindow and maxTokens across fallback refs', () => {
    const config: RouterConfig = {
      models: { hybrid: { models: ['provider/small', 'provider/big'] } },
    }
    const registry = {
      find: vi.fn((_p: string, modelId: string) => {
        if (modelId === 'small') return mockModel({ contextWindow: 32_000, maxTokens: 4_096 })
        if (modelId === 'big') return mockModel({ contextWindow: 200_000, maxTokens: 16_384 })
        return undefined
      }),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].contextWindow).toBe(200_000)
    expect(providerCfg.models[0].maxTokens).toBe(16_384)
  })

  it('sets reasoning=true when any fallback model supports reasoning', () => {
    const config: RouterConfig = {
      models: { smart: { models: ['provider/a', 'provider/b'] } },
    }
    const registry = {
      find: vi.fn((_p: string, modelId: string) => {
        if (modelId === 'a') return mockModel({ reasoning: false })
        return mockModel({ reasoning: true })
      }),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].reasoning).toBe(true)
  })

  it('merges thinkingLevelMap from underlying models', () => {
    const config: RouterConfig = {
      models: { thinker: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(
        mockModel({
          thinkingLevelMap: { high: 'high', medium: 'medium' },
        }),
      ),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].thinkingLevelMap).toEqual({
      high: 'high',
      medium: 'medium',
    })
  })

  it('leaves thinkingLevelMap undefined when no underlying model has one', () => {
    const config: RouterConfig = {
      models: { basic: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(
        mockModel({ thinkingLevelMap: undefined }),
      ),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].thinkingLevelMap).toBeUndefined()
  })

  it('uses defaults when underlying model is not found in registry', () => {
    const config: RouterConfig = {
      models: { missing: { models: ['unknown/provider'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0]).toMatchObject({
      id: 'missing',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: false,
      input: ['text'],
    })
  })

  it('skips refs that fail resolveModelRef gracefully', () => {
    const config: RouterConfig = {
      models: { mixed: { models: ['bad-ref', 'good/provider'] } },
    }
    const registry = {
      find: vi.fn((_p: string, modelId: string) => {
        if (modelId === 'x') {
          // 'bad-ref' resolves to null -> find is never called for it
        }
        return mockModel({ id: modelId })
      }),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(providerCfg.models[0].id).toBe('mixed')
    // 'good/provider' should be the only ref that contributed
    expect(providerCfg.models[0].contextWindow).toBe(128_000)
  })

  it('provides a streamSimple function in the registered provider', () => {
    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi.fn(),
    }

    registerRouterProvider(mockApi as never, config, registry as never)

    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    expect(typeof providerCfg.streamSimple).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Cooldown behaviour tests
// ---------------------------------------------------------------------------
describe('cooldown behaviour', () => {
  const mockApi = { registerProvider: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRateLimits()
  })

  /**
   * Build a mock delegated stream that yields one event then ends.
   */
  function delegatedStream(
    event: Record<string, unknown>,
  ): { [Symbol.asyncIterator]: () => AsyncIterator<any> } {
    let yielded = false
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (!yielded) {
            yielded = true
            return Promise.resolve({ done: false, value: event })
          }
          return Promise.resolve({ done: true, value: undefined })
        },
      }),
    }
  }

  /**
   * Build a mock delegated stream that yields text_delta then error then ends.
   */
  function delegatedStreamWithContent(
    firstEvent: Record<string, unknown>,
    secondEvent: Record<string, unknown>,
  ): { [Symbol.asyncIterator]: () => AsyncIterator<any> } {
    let step = 0
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          step++
          if (step === 1) return Promise.resolve({ done: false, value: firstEvent })
          if (step === 2) return Promise.resolve({ done: false, value: secondEvent })
          return Promise.resolve({ done: true, value: undefined })
        },
      }),
    }
  }

  /** Register router and return its streamSimple function + the stream._endPromise. */
  function setupRouter(config: RouterConfig, registry: any) {
    registerRouterProvider(mockApi as never, config, registry as never)
    const providerCfg = mockApi.registerProvider.mock.calls[0][1]
    return providerCfg
  }

  /** Create a delegated stream that succeeds (text_delta then done). */
  function successStream(): { [Symbol.asyncIterator]: () => AsyncIterator<any> } {
    let step = 0
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          step++
          if (step === 1)
            return Promise.resolve({
              done: false,
              value: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
            })
          if (step === 2)
            return Promise.resolve({
              done: false,
              value: { type: 'done', partial: {} },
            })
          return Promise.resolve({ done: true, value: undefined })
        },
      }),
    }
  }

  // -----------------------------------------------------------------------
  // RED-GREEN 1: Non-transient error → markRateLimited
  // -----------------------------------------------------------------------
  it('marks a model with cooldown after a non-transient error before content', async () => {
    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    }

    // Mock delegated streamSimple to return an error-before-content stream
    // Error message deliberately does NOT match any TRANSIENT_PATTERNS
    const { streamSimple } = await import('@earendil-works/pi-ai/compat')
    ;(streamSimple as ReturnType<typeof vi.fn>).mockReturnValue(
      delegatedStream({
        type: 'error',
        reason: 'error',
        error: { errorMessage: 'Model not found — invalid ref' },
      }),
    )

    const providerCfg = setupRouter(config, registry)

    const model: any = { id: 'test', provider: 'router', api: 'router-local-api' }
    const ctx: any = { messages: [{ role: 'user', content: 'hello' }] }

    const stream = providerCfg.streamSimple(model, ctx, {})

    // Wait for the async IIFE to complete
    await (stream as any)._endPromise

    // Then check cooldown state
    const limits = getActiveRateLimits()
    expect(limits.length).toBe(1)
    expect(limits[0].ref).toBe('openai/gpt-4')
  })

  // -----------------------------------------------------------------------
  // RED-GREEN 2: Cross-turn — failed model skipped on next call
  // -----------------------------------------------------------------------
  it('skips a cooldowned model on the next streamSimple call', async () => {
    clearRateLimits()

    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4', 'anthropic/claude-3'] } },
    }

    const gpt4Model = mockModel({ id: 'gpt-4', provider: 'openai' })
    const claudeModel = mockModel({ id: 'claude-3', provider: 'anthropic' })

    const registry = {
      find: vi.fn((_provider: string, modelId: string) => {
        if (modelId === 'gpt-4') return gpt4Model
        if (modelId === 'claude-3') return claudeModel
        return undefined
      }),
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    }

    const { streamSimple } = await import('@earendil-works/pi-ai/compat')
    const delegatedCalls: string[] = []

    ;(streamSimple as ReturnType<typeof vi.fn>).mockImplementation(
      (model: any) => {
        delegatedCalls.push(model.id)
        if (model.id === 'gpt-4') {
          return delegatedStream({
            type: 'error',
            reason: 'error',
            error: { errorMessage: 'Model not found' },
          })
        }
        return successStream()
      },
    )

    const providerCfg = setupRouter(config, registry)

    const routerModel: any = {
      id: 'test',
      provider: 'router',
      api: 'router-local-api',
    }
    const ctx: any = { messages: [{ role: 'user', content: 'hello' }] }

    // ---- Call 1: gpt-4 fails → cooldown, claude-3 succeeds ----
    const stream1 = providerCfg.streamSimple(routerModel, ctx, {})
    await (stream1 as any)._endPromise

    expect(getActiveRateLimits().length).toBe(1)
    expect(getActiveRateLimits()[0].ref).toBe('openai/gpt-4')
    // gpt-4 was delegated exactly once (in call 1)
    expect(delegatedCalls.filter((c) => c === 'gpt-4').length).toBe(1)

    // ---- Call 2: gpt-4 cooldowned → skip, claude-3 succeeds ----
    const stream2 = providerCfg.streamSimple(routerModel, ctx, {})
    await (stream2 as any)._endPromise

    // gpt-4 should NOT be delegated again — it was skipped by isRateLimited
    expect(delegatedCalls.filter((c) => c === 'gpt-4').length).toBe(1)
  })

  // -----------------------------------------------------------------------
  // Regression: transient error (rate limit) still triggers cooldown
  // -----------------------------------------------------------------------
  it('still marks transient errors with cooldown (regression)', async () => {
    clearRateLimits()

    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    }

    const { streamSimple } = await import('@earendil-works/pi-ai/compat')
    ;(streamSimple as ReturnType<typeof vi.fn>).mockReturnValue(
      delegatedStream({
        type: 'error',
        reason: 'error',
        error: { errorMessage: '429 Too Many Requests' },
      }),
    )

    const providerCfg = setupRouter(config, registry)
    const model: any = { id: 'test', provider: 'router', api: 'router-local-api' }
    const ctx: any = { messages: [{ role: 'user', content: 'hello' }] }

    const stream = providerCfg.streamSimple(model, ctx, {})
    await (stream as any)._endPromise

    const limits = getActiveRateLimits()
    expect(limits.length).toBe(1)
    expect(limits[0].ref).toBe('openai/gpt-4')
  })

  // -----------------------------------------------------------------------
  // Regression: RouterAbortError does NOT trigger cooldown
  // -----------------------------------------------------------------------
  it('does not cooldown on RouterAbortError (pi-level timeout)', async () => {
    clearRateLimits()

    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    }

    const { streamSimple } = await import('@earendil-works/pi-ai/compat')
    ;(streamSimple as ReturnType<typeof vi.fn>).mockReturnValue(
      delegatedStream({
        type: 'error',
        reason: 'aborted',
        error: { errorMessage: 'Request aborted by pi' },
      }),
    )

    const providerCfg = setupRouter(config, registry)
    const model: any = { id: 'test', provider: 'router', api: 'router-local-api' }
    const ctx: any = { messages: [{ role: 'user', content: 'hello' }] }

    const stream = providerCfg.streamSimple(model, ctx, {})
    await (stream as any)._endPromise

    // No cooldown should be applied for aborted requests
    expect(getActiveRateLimits().length).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Regression: provider-level error also cooldowns the provider
  // -----------------------------------------------------------------------
  it('cooldowns both model and provider on provider-level error', async () => {
    clearRateLimits()

    const config: RouterConfig = {
      models: { test: { models: ['openai/gpt-4'] } },
    }
    const registry = {
      find: vi.fn().mockReturnValue(mockModel()),
      getApiKeyAndHeaders: vi
        .fn()
        .mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    }

    const { streamSimple } = await import('@earendil-works/pi-ai/compat')
    ;(streamSimple as ReturnType<typeof vi.fn>).mockReturnValue(
      delegatedStream({
        type: 'error',
        reason: 'error',
        error: { errorMessage: '502 Bad Gateway' },
      }),
    )

    const providerCfg = setupRouter(config, registry)
    const model: any = { id: 'test', provider: 'router', api: 'router-local-api' }
    const ctx: any = { messages: [{ role: 'user', content: 'hello' }] }

    const stream = providerCfg.streamSimple(model, ctx, {})
    await (stream as any)._endPromise

    const limits = getActiveRateLimits()
    expect(limits.length).toBe(2)
    expect(limits.some((l) => l.ref === 'openai/gpt-4')).toBe(true)
    expect(limits.some((l) => l.ref === '__provider:openai')).toBe(true)
  })
})
