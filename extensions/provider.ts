/**
 * Router provider engine — registers the "router" provider with pi
 * and implements the fallback chain streamSimple.
 *
 * Each logical model in config.models defines an ordered list of
 * provider/model refs. streamSimple tries each ref in order,
 * falling back to the next on failure.
 */

import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type Message,
  type TextContent,
  type ThinkingLevel as AiThinkingLevel,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RouterConfig } from './types';
import { PROVIDER_NAME, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';
import { resolveModelRef, getMaxThinkingLevel, contextHasImage } from './config';
import { isRateLimited, markRateLimited, isRateLimitError } from './rate-limit-tracker';

// ---------------------------------------------------------------------------
// Helpers (provider-local — generic helpers live in ./config.ts)
// ---------------------------------------------------------------------------

/** Check whether the model referenced by a canonical ref supports image input. */
const modelSupportsImage = (ref: string, registry: ModelRegistry | null): boolean => {
  const resolved = resolveModelRef(ref, registry);
  if (!resolved || !registry) return false;
  const m = registry.find(resolved.provider, resolved.modelId);
  return m?.input?.includes('image') ?? false;
};

/**
 * Truncate messages from the front (oldest first) until the
 * serialized length fits within maxChars. Always keeps the
 * last message.
 */
const truncateMessages = (messages: Message[], maxChars: number): Message[] => {
  if (messages.length <= 1) return messages;

  const result = [...messages];
  while (result.length > 1) {
    const total = JSON.stringify(result).length;
    if (total <= maxChars) break;
    result.shift();
  }
  return result;
};

// ---------------------------------------------------------------------------
// Model definition builder
// ---------------------------------------------------------------------------

/** Build the model array to pass to registerProvider. */
const buildModels = (
  config: RouterConfig,
  registry: ModelRegistry | null,
): Array<{
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}> =>
  Object.entries(config.models).map(([name, cfg]) => {
    const refs = cfg.models;

    let maxCtx = DEFAULT_CONTEXT_WINDOW;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let reasoning = false;
    let hasImage = false;
    const thinkingLevelSet = new Set<string>();

    for (const ref of refs) {
      const resolved = resolveModelRef(ref, registry);
      if (!resolved) continue;
      // Skip metadata lookup when registry is not available yet
      // (eager registration). Defaults will be used.
      if (!registry) continue;
      const m = registry.find(resolved.provider, resolved.modelId);
      if (!m) continue;

      if (m.contextWindow > maxCtx) maxCtx = m.contextWindow;
      if (m.maxTokens > maxTokens) maxTokens = m.maxTokens;
      if (m.reasoning) reasoning = true;
      if (m.input?.includes('image')) hasImage = true;

      if (m.thinkingLevelMap) {
        for (const [level, val] of Object.entries(m.thinkingLevelMap)) {
          if (val !== null) thinkingLevelSet.add(level);
        }
      }
    }

    const thinkingLevelMap =
      thinkingLevelSet.size > 0
        ? Object.fromEntries([...thinkingLevelSet].map((l) => [l, l])) as Partial<Record<ModelThinkingLevel, string | null>>
        : undefined;

    return {
      id: name,
      name: `Router ${name}`,
      reasoning,
      input: hasImage ? (['text', 'image'] as ('text' | 'image')[]) : (['text'] as ('text' | 'image')[]),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: maxCtx,
      maxTokens,
      thinkingLevelMap,
    };
  });

// ---------------------------------------------------------------------------
// streamSimple implementation
// ---------------------------------------------------------------------------

/** Create the initial AssistantMessage skeleton for stream events. */
const createEmptyMessage = (model: Model<Api>): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
});

/** Create an AssistantMessage for an error outcome. */
const createErrorMessage = (model: Model<Api>, message: string): AssistantMessage => ({
  ...createEmptyMessage(model),
  stopReason: 'error',
  errorMessage: message,
});

/** Push a text content block into the event stream (used for fallback notifications). */
const pushTextBlock = (
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  text: string,
): void => {
  const ci = output.content.length;
  output.content.push({ type: 'text', text: '' });
  stream.push({ type: 'text_start', contentIndex: ci, partial: { ...output } });
  (output.content[ci] as TextContent).text = text;
  stream.push({ type: 'text_delta', contentIndex: ci, delta: text, partial: { ...output } });
  stream.push({ type: 'text_end', contentIndex: ci, content: text, partial: { ...output } });
};

/** The router's streamSimple: iterate fallback chain and delegate. */
const routeStream = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  registry: ModelRegistry | null,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const customName = model.id;
    const cfg = config.models[customName];
    if (!cfg) {
      stream.push({
        type: 'error',
        reason: 'error',
        error: createErrorMessage(model, `Unknown router model: ${customName}`),
      });
      stream.end();
      return;
    }

    const refs = cfg.models;
    const hasImages = contextHasImage(context);
    const userThinking: ThinkingLevel | null | undefined = cfg.thinking;

    // Registry must be available for fallback delegation
    if (!registry) {
      stream.push({
        type: 'error',
        reason: 'error',
        error: createErrorMessage(model, 'Router not initialized — model registry unavailable'),
      });
      stream.end();
      return;
    }

    // Filter candidates by image support when context has images
    const candidates = hasImages
      ? refs.filter((ref) => modelSupportsImage(ref, registry))
      : [...refs];

    if (candidates.length === 0) {
      stream.push({
        type: 'error',
        reason: 'error',
        error: createErrorMessage(
          model,
          `No available model for ${customName} (all filtered out)`,
        ),
      });
      stream.end();
      return;
    }

    const output = createEmptyMessage(model);
    stream.push({ type: 'start', partial: output });

    let lastError: Error | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const ref = candidates[i];

      // --- Rate-limit cooldown check (skip if still in cooldown) ---
      if (isRateLimited(ref)) {
        lastError = new Error(`${ref} is rate-limited (cooldown active)`);
        if (i < candidates.length - 1) {
          const nextRef = candidates[i + 1];
          pushTextBlock(
            stream,
            output,
            `\n⏳ ${ref} cooldown, skip ke ${nextRef}\n`,
          );
        }
        continue;
      }

      const resolved = resolveModelRef(ref, registry);
      if (!resolved) {
        lastError = new Error(`Invalid model ref: ${ref}`);
        continue;
      }

      const targetModel = registry.find(resolved.provider, resolved.modelId);
      if (!targetModel) {
        lastError = new Error(`Model not found in registry: ${ref}`);
        continue;
      }

      // Auth
      const auth = await registry.getApiKeyAndHeaders(targetModel);
      if (!auth.ok || !auth.apiKey) {
        lastError = new Error(
          auth.ok
            ? `No API key for ${ref}`
            : `Auth failed for ${ref}: ${auth.error}`,
        );
        continue;
      }

      // Thinking degradation — cap to the model's maximum supported level
      let effectiveThinking: string | undefined;
      if (userThinking !== null && userThinking !== undefined) {
        if (userThinking === 'off') {
          effectiveThinking = undefined;
        } else {
          const maxLevel = getMaxThinkingLevel(targetModel);
          if (maxLevel === 'off') {
            // Model doesn't support reasoning at all
            effectiveThinking = undefined;
          } else {
            // Compare ordering: higher index = higher capability
            const ORDER: Record<string, number> = {
              off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5,
            };
            const userIdx = ORDER[userThinking] ?? 0;
            const maxIdx = ORDER[maxLevel] ?? 0;
            effectiveThinking = userIdx <= maxIdx ? userThinking : maxLevel;
          }
        }
      }

      // Context truncation (simple oldest-first heuristic)
      let ctx = context;
      if (targetModel.contextWindow) {
        const maxChars = targetModel.contextWindow * 3;
        const totalChars = JSON.stringify(ctx.messages).length;
        if (totalChars > maxChars) {
          ctx = { ...ctx, messages: truncateMessages(ctx.messages, maxChars) };
        }
      }

      try {
        const reasoningOption = effectiveThinking
          ? { reasoning: effectiveThinking as AiThinkingLevel }
          : {};

        const delegatedStream = streamSimple(targetModel, ctx, {
          ...options,
          apiKey: auth.apiKey,
          headers: auth.headers,
          ...reasoningOption,
        });

        let contentReceived = false;
        for await (const event of delegatedStream) {
          // If error arrives before any content, treat as delegation failure
          if (event.type === 'error' && !contentReceived) {
            throw new Error(
              event.error.errorMessage ?? `Model ${ref} failed before sending content`,
            );
          }
          if (
            event.type === 'text_delta' ||
            event.type === 'thinking_delta' ||
            event.type === 'toolcall_delta' ||
            event.type === 'toolcall_end'
          ) {
            contentReceived = true;
          }
          stream.push(event);
          if (event.type === 'done') {
            stream.end();
            return; // success
          }
        }
        // Stream ended without a done event (shouldn't happen)
        stream.end();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Mark failed model with cooldown so it's skipped on subsequent turns
        markRateLimited(ref, config.rateLimitCooldownMs);

        const isLast = i === candidates.length - 1;
        if (!isLast) {
          const nextRef = candidates[i + 1];
          const prefix = isRateLimitError(lastError) ? '🚫' : '⚠️';
          const cause = isRateLimitError(lastError) ? ' (rate limit)' : '';
          pushTextBlock(
            stream,
            output,
            `\n${prefix} ${ref} gagal${cause}, fallback ke ${nextRef}\n`,
          );
        }
      }
    }

    // All fallbacks exhausted
    stream.push({
      type: 'error',
      reason: 'error',
      error: createErrorMessage(
        model,
        lastError
          ? `Semua model di ${customName} gagal. Terakhir: ${lastError.message}`
          : `Semua model di ${customName} gagal`,
      ),
    });
    stream.end();
  })();

  return stream;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the "router" provider with pi.
 *
 * @param api           ExtensionAPI instance
 * @param config        Normalized RouterConfig
 * @param modelRegistry  ModelRegistry from extension context
 */
export const registerRouterProvider = (
  api: ExtensionAPI,
  config: RouterConfig,
  modelRegistry: ModelRegistry | null,
): void => {
  const models = buildModels(config, modelRegistry);

  api.registerProvider(PROVIDER_NAME, {
    baseUrl: 'http://router.local',
    apiKey: 'pi-model-router',
    api: 'router-local-api' as Api,
    models,
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream =>
      routeStream(model, context, options, config, modelRegistry),
  });
};
