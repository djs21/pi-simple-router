import { describe, it, expect } from 'vitest'
import {
  normalizeConfig,
  getMaxThinkingLevel,
  contextHasImage,
  resolveModelRef,
} from './config'

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------
describe('normalizeConfig', () => {
  it('returns RouterConfig for valid input with one model', () => {
    const result = normalizeConfig({
      models: {
        thinker: { models: ['openai/gpt-4'] },
      },
    })
    expect(result).toEqual({
      models: {
        thinker: { models: ['openai/gpt-4'] },
      },
    })
  })

  it('preserves thinking level when provided', () => {
    const result = normalizeConfig({
      models: {
        thinker: { models: ['openai/gpt-4'], thinking: 'high' },
      },
    })
    expect(result.models.thinker.thinking).toBe('high')
  })

  it('accepts multiple models with multiple fallback refs', () => {
    const result = normalizeConfig({
      models: {
        premium: { models: ['opencode-go/deepseek-v4-pro', 'openai/gpt-4'] },
        free: { models: ['opencode/deepseek-v4-flash-free'] },
      },
    })
    expect(Object.keys(result.models)).toHaveLength(2)
    expect(result.models.premium.models).toEqual([
      'opencode-go/deepseek-v4-pro',
      'openai/gpt-4',
    ])
    expect(result.models.free.models).toEqual(['opencode/deepseek-v4-flash-free'])
  })

  it('accepts empty models object', () => {
    const result = normalizeConfig({ models: {} })
    expect(result.models).toEqual({})
  })

  it('throws for null input', () => {
    expect(() => normalizeConfig(null)).toThrow('Config must be a non-null object')
  })

  it('throws for string input', () => {
    expect(() => normalizeConfig('not-an-object')).toThrow(
      'Config must be a non-null object',
    )
  })

  it('throws for number input', () => {
    expect(() => normalizeConfig(42)).toThrow('Config must be a non-null object')
  })

  it('throws for array input (typeof === object but models missing)', () => {
    expect(() => normalizeConfig([])).toThrow()
  })

  it('throws when models key is missing', () => {
    expect(() => normalizeConfig({})).toThrow('Config must contain a "models" object')
  })

  it('throws when models is not an object', () => {
    expect(() => normalizeConfig({ models: 'string' })).toThrow(
      'Config must contain a "models" object',
    )
  })

  it('throws when a model entry is not an object', () => {
    expect(() =>
      normalizeConfig({ models: { m1: 'not-an-object' } }),
    ).toThrow('Model "m1" must be an object')
  })

  it('throws when a model entry has no models array', () => {
    expect(() => normalizeConfig({ models: { m1: {} } })).toThrow(
      'Model "m1" must have a "models" array',
    )
  })

  it('throws when models array contains non-strings', () => {
    expect(() =>
      normalizeConfig({ models: { m1: { models: [42] } } }),
    ).toThrow('Model "m1" "models" entries must be strings')
  })

  it('throws when thinking is not a string', () => {
    expect(() =>
      normalizeConfig({
        models: { m1: { models: ['p/m'], thinking: 123 } },
      }),
    ).toThrow('Model "m1" "thinking" must be a string')
  })
})

// ---------------------------------------------------------------------------
// normalizeConfig — providers field
// ---------------------------------------------------------------------------
describe('normalizeConfig with providers', () => {
  it('parses providers field with basic entry', () => {
    const result = normalizeConfig({
      models: {},
      providers: {
        'my-vllm': {
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'ollama',
          api: 'openai-completions',
          models: [{ id: 'qwen2.5-coder:7b' }],
        },
      },
    })
    expect(result.providers).toBeDefined()
    expect(result.providers!['my-vllm']).toBeDefined()
    expect(result.providers!['my-vllm'].baseUrl).toBe('http://localhost:11434/v1')
    expect(result.providers!['my-vllm'].apiKey).toBe('ollama')
    expect(result.providers!['my-vllm'].api).toBe('openai-completions')
    expect(result.providers!['my-vllm'].models).toHaveLength(1)
    expect(result.providers!['my-vllm'].models[0].id).toBe('qwen2.5-coder:7b')
  })

  it('defaults managed to true when not set', () => {
    const result = normalizeConfig({
      models: {},
      providers: {
        myp: {
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'k',
          api: 'openai-completions',
          models: [{ id: 'm' }],
        },
      },
    })
    expect(result.providers!['myp'].managed).toBe(true)
  })

  it('respects managed: false', () => {
    const result = normalizeConfig({
      models: {},
      providers: {
        myp: {
          managed: false,
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'k',
          api: 'openai-completions',
          models: [{ id: 'm' }],
        },
      },
    })
    expect(result.providers!['myp'].managed).toBe(false)
  })

  it('parses optional authHeader, headers, compat', () => {
    const result = normalizeConfig({
      models: {},
      providers: {
        proxy: {
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: '$PROXY_KEY',
          api: 'anthropic-messages',
          authHeader: true,
          headers: { 'x-custom': 'val' },
          compat: { supportsDeveloperRole: false },
          models: [{ id: 'claude-sonnet-4', reasoning: true, input: ['text', 'image'] }],
        },
      },
    })
    const p = result.providers!['proxy']
    expect(p.authHeader).toBe(true)
    expect(p.headers).toEqual({ 'x-custom': 'val' })
    expect(p.compat).toEqual({ supportsDeveloperRole: false })
    expect(p.models[0].reasoning).toBe(true)
    expect(p.models[0].input).toEqual(['text', 'image'])
  })

  it('accepts empty providers object', () => {
    const result = normalizeConfig({ models: {}, providers: {} })
    expect(result.providers).toEqual({})
  })

  it('throws when providers is not an object', () => {
    expect(() => normalizeConfig({ models: {}, providers: 'string' })).toThrow(
      'Config "providers" must be a non-null object',
    )
  })

  it('throws when provider entry is not an object', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: { myp: 'string' },
      }),
    ).toThrow('Provider "myp" must be an object')
  })

  it('throws when provider has no baseUrl', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: { apiKey: 'k', api: 'o', models: [{ id: 'm' }] },
        },
      }),
    ).toThrow('Provider "myp" must have a non-empty "baseUrl" string')
  })

  it('throws when provider has no apiKey', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: { baseUrl: 'http://localhost:11434/v1', api: 'o', models: [{ id: 'm' }] },
        },
      }),
    ).toThrow('Provider "myp" must have a non-empty "apiKey" string')
  })

  it('throws when provider has no api', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', models: [{ id: 'm' }] },
        },
      }),
    ).toThrow('Provider "myp" must have a non-empty "api" string')
  })

  it('throws when provider has no models array', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', api: 'openai-completions' },
        },
      }),
    ).toThrow('Provider "myp" must have a "models" array')
  })

  it('throws when model entry has no id', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: {
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'k',
            api: 'openai-completions',
            models: [{ name: 'no-id' }],
          },
        },
      }),
    ).toThrow('Provider "myp" models[0] must have a non-empty "id" string')
  })

  it('throws when headers is not an object', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: {
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'k',
            api: 'openai-completions',
            headers: 'not-object',
            models: [{ id: 'm' }],
          },
        },
      }),
    ).toThrow('Provider "myp" "headers" must be an object')
  })

  it('throws when compat is not an object', () => {
    expect(() =>
      normalizeConfig({
        models: {},
        providers: {
          myp: {
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'k',
            api: 'openai-completions',
            compat: 'string',
            models: [{ id: 'm' }],
          },
        },
      }),
    ).toThrow('Provider "myp" "compat" must be an object')
  })

  it('coexists with existing models config', () => {
    const result = normalizeConfig({
      models: { thinker: { models: ['openai/gpt-4'] } },
      providers: {
        local: {
          baseUrl: 'http://localhost:11434/v1',
          apiKey: 'k',
          api: 'openai-completions',
          models: [{ id: 'llama3.1:8b' }],
        },
      },
    })
    expect(result.models.thinker).toBeDefined()
    expect(result.providers!['local']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// getMaxThinkingLevel
// ---------------------------------------------------------------------------
describe('getMaxThinkingLevel', () => {
  it('returns "off" when reasoning is false', () => {
    expect(getMaxThinkingLevel({ reasoning: false })).toBe('off')
  })

  it('returns "off" when reasoning is false even with thinkingLevelMap', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: false,
        thinkingLevelMap: { high: 'high' },
      }),
    ).toBe('off')
  })

  it('returns "high" when reasoning is true and no thinkingLevelMap', () => {
    expect(getMaxThinkingLevel({ reasoning: true })).toBe('high')
  })

  it('returns "high" when thinkingLevelMap has "high" but not "xhigh"', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { high: 'high', medium: 'medium' },
      }),
    ).toBe('high')
  })

  it('returns "xhigh" when thinkingLevelMap includes "xhigh"', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', medium: 'medium' },
      }),
    ).toBe('xhigh')
  })

  it('returns first supported level from CONFIG_LEVELS order', () => {
    // only 'medium' and 'low' are set; 'xhigh' and 'high' are absent
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { low: 'low', medium: 'medium' },
      }),
    ).toBe('medium')
  })

  it('returns "low" when only low is available', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { low: 'low' },
      }),
    ).toBe('low')
  })

  it('returns "off" when all thinkingLevelMap values are null', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { high: null, medium: null, low: null },
      }),
    ).toBe('off')
  })

  it('returns "off" when thinkingLevelMap only has keys outside CONFIG_LEVELS', () => {
    // 'off' and 'minimal' are not in CONFIG_LEVELS => no match => 'off'
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: { off: 'off', minimal: 'minimal' },
      }),
    ).toBe('off')
  })

  it('skips null entries and finds the next valid level', () => {
    expect(
      getMaxThinkingLevel({
        reasoning: true,
        thinkingLevelMap: {
          xhigh: null,
          high: null,
          medium: 'medium',
          low: null,
        },
      }),
    ).toBe('medium')
  })
})

// ---------------------------------------------------------------------------
// contextHasImage
// ---------------------------------------------------------------------------
describe('contextHasImage', () => {
  it('returns false when messages is undefined', () => {
    expect(contextHasImage({})).toBe(false)
  })

  it('returns false for empty messages array', () => {
    expect(contextHasImage({ messages: [] })).toBe(false)
  })

  it('returns true when a content block has type "image"', () => {
    const ctx = {
      messages: [
        {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
    }
    expect(contextHasImage(ctx)).toBe(true)
  })

  it('returns true when a content block has image mimeType', () => {
    const ctx = {
      messages: [
        { content: [{ mimeType: 'image/png' }] },
      ],
    }
    expect(contextHasImage(ctx)).toBe(true)
  })

  it('returns false for text-only content blocks', () => {
    const ctx = {
      messages: [
        { content: [{ type: 'text', text: 'hello' }] },
      ],
    }
    expect(contextHasImage(ctx)).toBe(false)
  })

  it('returns false when content is a string (not array)', () => {
    const ctx = {
      messages: [
        { content: 'plain string' },
      ],
    }
    expect(contextHasImage(ctx)).toBe(false)
  })

  it('returns false for non-image mimeType', () => {
    const ctx = {
      messages: [
        { content: [{ mimeType: 'application/json' }] },
      ],
    }
    expect(contextHasImage(ctx)).toBe(false)
  })

  it('returns true when image is in a later message', () => {
    const ctx = {
      messages: [
        { content: [{ type: 'text', text: 'first' }] },
        { content: [{ type: 'image', data: 'abc' }] },
      ],
    }
    expect(contextHasImage(ctx)).toBe(true)
  })

  it('safely handles null/undefined blocks in content array', () => {
    const ctx = {
      messages: [
        { content: [null, undefined, { type: 'text', text: 'hello' }] },
      ],
    }
    expect(contextHasImage(ctx)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveModelRef
// ---------------------------------------------------------------------------
describe('resolveModelRef', () => {
  it('parses "provider/model" into provider and modelId', () => {
    const result = resolveModelRef('openai/gpt-4', {})
    expect(result).toEqual({ provider: 'openai', modelId: 'gpt-4' })
  })

  it('parses ref with additional slashes in modelId', () => {
    const result = resolveModelRef('a/b/c', {})
    expect(result).toEqual({ provider: 'a', modelId: 'b/c' })
  })

  it('parses multi-segment provider name', () => {
    const result = resolveModelRef('opencode-go/deepseek-v4-pro', {})
    expect(result).toEqual({
      provider: 'opencode-go',
      modelId: 'deepseek-v4-pro',
    })
  })

  it('returns null when there is no slash', () => {
    expect(resolveModelRef('noslash', {})).toBeNull()
  })

  it('returns null when slash is at the beginning', () => {
    expect(resolveModelRef('/leading', {})).toBeNull()
  })

  it('returns null when slash is at the end', () => {
    expect(resolveModelRef('trailing/', {})).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(resolveModelRef('', {})).toBeNull()
  })
})
