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

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: vi.fn(() => {
    const stream = {
      push: vi.fn(),
      end: vi.fn(),
    }
    stream[Symbol.asyncIterator] = vi.fn()
    return stream
  }),
}))

// Module under test — must come after vi.mock calls
import { registerRouterProvider } from './provider'

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
        baseUrl: '',
        apiKey: '',
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
