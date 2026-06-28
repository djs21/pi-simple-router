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
