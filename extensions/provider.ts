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
import { isRateLimited, markRateLimited, classifyError, resetCooldown, isRateLimitError } from './rate-limit-tracker';
import { recordUsage } from './usage-tracker';

// ---------------------------------------------------------------------------
// Helpers (provider-local — generic helpers live in ./config.ts)
// ---------------------------------------------------------------------------

/** Error patterns indicating a provider-wide outage (not model-specific). */
const PROVIDER_LEVEL_PATTERNS = [
  '502', '503', '504',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'overloaded',
];
const isProviderLevelError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return PROVIDER_LEVEL_PATTERNS.some(p => msg.includes(p));
};

// ---------------------------------------------------------------------------
// Smart model lookup — handles OpenRouter's upstream-prefixed model IDs
// ---------------------------------------------------------------------------

/**
 * Find a model in the registry with smart fallback.
 *
 * Some providers (notably OpenRouter) register models with upstream-prefixed
 * IDs like `"deepseek/deepseek-v4-flash"` or `"openrouter/owl-alpha"`.
 * Users can write config refs in either format:
 *   - Full:   `"openrouter/deepseek/deepseek-v4-flash"`  (explicit)
 *   - Short:  `"openrouter/owl-alpha"`                   (missing upstream prefix)
 *
 * The short form fails `registry.find` because the model ID is
 * `"openrouter/owl-alpha"`, not `"owl-alpha"`.  This function:
 *   1. Tries exact lookup first.
 *   2. If that fails, tries prepending the provider name as upstream prefix.
 */
const findModel = (
  registry: ModelRegistry,
  provider: string,
  modelId: string,
): ReturnType<ModelRegistry['find']> => {
  // 1. Exact match
  const m = registry.find(provider, modelId);
  if (m) return m;

  // 2. Try prepending provider as upstream prefix (handles OpenRouter)
  const prefixedId = `${provider}/${modelId}`;
  const m2 = registry.find(provider, prefixedId);
  if (m2) return m2;

  return null;
};

/**
 * Sync model.contextWindow to the resolved model's contextWindow.
 * Direct mutation — propagates immediately to pi's footer display.
 * No-op if model is null or ref can't be resolved.
 */
export const syncContextWindow = (
  model: { contextWindow: number } | null,
  ref: string,
  registry: ModelRegistry,
): void => {
  if (!model) return;
  const resolved = resolveModelRef(ref, registry);
  if (!resolved) return;
  const targetModel = findModel(registry, resolved.provider, resolved.modelId);
  if (!targetModel) return;
  model.contextWindow = targetModel.contextWindow;
};

/** Check whether the model referenced by a canonical ref supports image input. */
const modelSupportsImage = (ref: string, registry: ModelRegistry | null): boolean => {
  const resolved = resolveModelRef(ref, registry);
  if (!resolved || !registry) return false;
  const m = findModel(registry, resolved.provider, resolved.modelId);
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

// ---------------------------------------------------------------------------
// Auth cache — avoid redundant getApiKeyAndHeaders calls per session
// ---------------------------------------------------------------------------

interface CachedAuth {
  apiKey: string;
  headers: Record<string, string>;
}

const authCache = new Map<string, CachedAuth>();

/**
 * Get auth for a model, using in-memory cache per session.
 * Cache key is `${provider}/${modelId}`.
 */
async function getCachedAuth(
  targetModel: Model<Api>,
  registry: ModelRegistry,
): Promise<{ apiKey: string; headers: Record<string, string> } | null> {
  const cacheKey = `${targetModel.provider}/${targetModel.id}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached;

  const auth = await registry.getApiKeyAndHeaders(targetModel);
  if (!auth || !auth.ok || !auth.apiKey) return null;

  const result: CachedAuth = { apiKey: auth.apiKey, headers: auth.headers };
  authCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Timeout / abort helpers
// ---------------------------------------------------------------------------

/** Error class for router-level timeouts (pi aborted the request). */
class RouterAbortError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RouterAbortError';
  }
}

/** Error class for per-model timeout (model too slow to start). */
class ModelTimeoutError extends Error {
  constructor(ref: string, elapsedMs: number) {
    super(`${ref} timeout after ${(elapsedMs / 1000).toFixed(1)}s`);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * Check abort signal and throw RouterAbortError if pi has cancelled.
 * Call after every await in the fallback loop.
 */
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RouterAbortError(
      'Pi membatalkan request (timeout). ' +
      'Model terlalu lambat merespon melalui chain fallback.',
    );
  }
}

/**
 * Attempt one model in the chain with abort awareness.
 * Returns true if the model succeeded (outer loop should stop).
 * Throws on abort (pi-level timeout), returns false on delegation failure.
 */
async function tryModel(
  ref: string,
  targetModel: Model<Api>,
  ctx: Context,
  options: SimpleStreamOptions | undefined,
  reasoningOption: Record<string, unknown>,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  config: RouterConfig,
  registry: ModelRegistry,
  refIdx: number,
  totalRefs: number,
  elapsedStart: number,
): Promise<boolean> {
  const signal = options?.signal;

  // Check aborted BEFORE attempting this model
  checkAborted(signal);

  // Auth (cached per provider/model across the session)
  const auth = await getCachedAuth(targetModel, registry);
  checkAborted(signal);

  if (!auth) {
    throw new Error(`Auth gagal untuk ${ref}`);
  }

  const delegatedStream = streamSimple(targetModel, ctx, {
    ...options,
    apiKey: auth.apiKey,
    headers: auth.headers,
    ...reasoningOption,
  });

  // Race: actual stream vs abort signal
  // We iterate the stream but also check signal between events
  let contentReceived = false;
  let erredAfterContent = false;
  const iterator = delegatedStream[Symbol.asyncIterator]();

  while (true) {
    checkAborted(signal);

    const nextPromise = iterator.next();

    // Race the next event against the abort signal
    // If signal fires while waiting for next event, pi timed us out
    let result: IteratorResult<AssistantMessageEventStream[0]>;
    if (signal) {
      // If signal is already aborted, fail fast without waiting
      if (signal.aborted) {
        // Cancel the pending iterator — fire-and-forget, stream cleanup is best-effort
        result = { done: true, value: undefined as any };
      } else {
        // Wait for next event OR abort, whichever comes first
        result = await Promise.race([
          nextPromise,
          new Promise<never>((_, reject) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort);
              reject(new RouterAbortError(
                'Pi membatalkan request saat menunggu stream dari ' + ref,
              ));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      }
    } else {
      result = await nextPromise;
    }

    // Check aborted again after await
    checkAborted(signal);

    if (result.done) break;

    const event = result.value;

    // If error arrives before any content, treat as delegation failure
    if (event.type === 'error' && !contentReceived) {
      // Capture usage — provider tetap charge meskipun error
      try {
        const finalMsg = await delegatedStream.result();
        if (finalMsg?.usage) {
          recordUsage(output.model, ref, finalMsg.usage);
        }
      } catch { /* usage unavailable */ }
      const errMsg = event.error.errorMessage ?? `Model ${ref} failed before sending content`;
      // Classify: if it's an abort/aborted, treat as RouterAbortError
      if (event.reason === 'aborted') {
        throw new RouterAbortError(errMsg);
      }
      throw new Error(errMsg);
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

    // Error after content: model produced some output then failed.
    // Cooldown it so it is skipped on subsequent turns.
    // (Error-before-content throws to the routeStream catch block instead.)
    if (event.type === 'error' && contentReceived && event.reason !== 'aborted') {
      const errType = classifyError(event.error?.errorMessage ?? 'Unknown');
      markRateLimited(ref, config.rateLimitCooldownMs, errType);
      erredAfterContent = true;
    }

    if (event.type === 'done') {
      if (erredAfterContent) {
        // Capture usage — provider tetap charge meskipun error
        try {
          const finalMsg = await delegatedStream.result();
          if (finalMsg?.usage) {
            recordUsage(output.model, ref, finalMsg.usage);
          }
        } catch { /* usage unavailable */ }
        stream.end();
        return false;
      }
      resetCooldown(ref);
      // Capture real usage dari delegated stream
      try {
        const finalMsg = await delegatedStream.result();
        if (finalMsg?.usage) {
          recordUsage(output.model, ref, finalMsg.usage);
        }
      } catch { /* usage unavailable */ }
      stream.end();
      return true;
    }
  }

  // Stream ended naturally (no done event — shouldn't happen)
  stream.end();
  return true;
}

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

    // Track elapsed time for diagnostics
    const elapsedStart = Date.now();

    let lastError: Error | undefined;

    // Check if pi already aborted before any work
    try { checkAborted(options?.signal); } catch (e) {
      const err = e as Error;
      stream.push({
        type: 'error',
        reason: 'error',
        error: createErrorMessage(model,
          `Request sudah dibatalkan sebelum fallback dimulai: ${err.message}`),
      });
      stream.end();
      return;
    }

    for (let i = 0; i < candidates.length; i++) {
      const ref = candidates[i];
      const isLast = i === candidates.length - 1;

      // --- Abort check before each candidate ---
      try { checkAborted(options?.signal); } catch (e) {
        lastError = e as Error;
        break;
      }

      const resolved = resolveModelRef(ref, registry);
      if (!resolved) {
        lastError = new Error(`Unknown model: ${ref}`);
        if (!isLast) {
          pushTextBlock(stream, output, `\n⚠️ ${ref} tidak dikenal, skip\n`);
        }
        continue;
      }

      // --- Cooldown check (model-level) ---
      // Skip silently — no text block noise every turn.
      // Footer via turn_start shows the active model; /router status shows details.
      if (isRateLimited(ref)) {
        lastError = new Error(`${ref} lagi cooldown`);
        continue;
      }

      // --- Cooldown check (provider-level) ---
      if (isRateLimited(`__provider:${resolved.provider}`)) {
        lastError = new Error(`Provider ${resolved.provider} sedang cooldown`);
        continue;
      }

      const targetModel = findModel(registry, resolved.provider, resolved.modelId);
      if (!targetModel) {
        lastError = new Error(`Model not found in registry: ${ref}`);
        continue;
      }

      // Auth (cached per provider/model across the session)
      const auth = await getCachedAuth(targetModel, registry);
      if (!auth) {
        lastError = new Error(`Auth gagal untuk ${ref}`);
        if (!isLast) {
          pushTextBlock(stream, output, `\n🔑 ${ref} gagal auth, skip\n`);
        }
        continue;
      }

      // Abort check after auth
      try { checkAborted(options?.signal); } catch (e) {
        lastError = e as Error;
        break;
      }

      // Thinking degradation — cap to the model's maximum supported level
      let effectiveThinking: string | undefined;
      if (userThinking !== null && userThinking !== undefined) {
        if (userThinking === 'off') {
          effectiveThinking = undefined;
        } else {
          // Known thinking levels with capability ordering
          const ORDER: Record<string, number> = {
            off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5,
          };
          // If thinking is set to a non-standard value like "default",
          // treat it as "inherit from pi settings" — skip override.
          if (!(userThinking in ORDER)) {
            effectiveThinking = undefined;
          } else {
            const maxLevel = getMaxThinkingLevel(targetModel);
            if (maxLevel === 'off') {
              // Model doesn't support reasoning at all
              effectiveThinking = undefined;
            } else {
              // Compare ordering: higher index = higher capability
              const userIdx = ORDER[userThinking] ?? 0;
              const maxIdx = ORDER[maxLevel] ?? 0;
              effectiveThinking = userIdx <= maxIdx ? userThinking : maxLevel;
            }
          }
        }
      }

      // Context truncation (simple oldest-first heuristic)
      let ctx = context;
      if (targetModel.contextWindow) {
        try {
          const maxChars = targetModel.contextWindow * 3;
          const totalChars = JSON.stringify(ctx.messages).length;
          if (totalChars > maxChars) {
            ctx = { ...ctx, messages: truncateMessages(ctx.messages, maxChars) };
          }
        } catch {
          // JSON.stringify failed (circular ref, etc). Use full context without truncation.
        }
      }

      const reasoningOption = effectiveThinking
        ? { reasoning: effectiveThinking as AiThinkingLevel }
        : {};

      try {
        const succeeded = await tryModel(
          ref, targetModel, ctx, options, reasoningOption,
          stream, output, config, registry,
          i, candidates.length, elapsedStart,
        );
        if (succeeded) return; // outer IIFE returns, stream already ended inside tryModel

        // Error-after-content: tryModel returned false → sync CTW to next candidate
        const syncRef = isLast ? ref : candidates[i + 1];
        syncContextWindow(model, syncRef, registry);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Determine failure type for messaging
        const isAbort = lastError instanceof RouterAbortError;
        const isTimeout = lastError instanceof ModelTimeoutError;

        // Cooldown ALL model errors (not just transient) so failed models
        // are skipped on subsequent turns. RouterAbortError (pi timeout) is
        // NOT a model error — don't cooldown, just fail fast.
        if (!isAbort) {
          // Cooldown model-level dengan error classification
          const errType = classifyError(lastError);
          markRateLimited(ref, config.rateLimitCooldownMs, errType);
          // Cooldown provider-level untuk infra errors (502, 503, 504, dll)
          if (isProviderLevelError(lastError)) {
            markRateLimited(`__provider:${resolved.provider}`, config.rateLimitCooldownMs, 'provider_outage');
          }
          // Sync CTW to reflect the next model that will handle requests
          const syncRef = isLast ? ref : candidates[i + 1];
          syncContextWindow(model, syncRef, registry);
        }

        if (!isLast) {
          const nextRef = candidates[i + 1];
          let prefix = '⚠️';
          let cause = '';
          if (isAbort) {
            prefix = '⏰';
            cause = ' (request dibatalkan pi)';
          } else if (isTimeout) {
            prefix = '⏰';
            cause = ' (timeout)';
          } else if (isRateLimitError(lastError)) {
            prefix = '🚫';
            cause = ' (rate limit)';
          }
          pushTextBlock(
            stream,
            output,
            `\n${prefix} ${ref} gagal${cause}, fallback ke ${nextRef}\n`,
          );
        } else {
          // Last model failed — is this an abort/timeout or real error?
          // We'll report it in the final error message
        }
      }

      // If last model failed due to abort, don't bother with further candidates
      if (lastError instanceof RouterAbortError) break;
    }

    // All fallbacks exhausted
    const elapsed = ((Date.now() - elapsedStart) / 1000).toFixed(1);
    let errorMsg: string;

    if (candidates.every(ref => isRateLimited(ref))) {
      errorMsg = `Semua model di ${customName} sedang cooldown. Tunggu beberapa menit atau gunakan /router clearcache`;
    } else if (lastError instanceof RouterAbortError) {
      errorMsg = `Request dibatalkan setelah ${elapsed}s: pi menghentikan permintaan. ` +
        `Model terlalu lambat merespon melalui chain fallback. Coba model langsung atau tambah model yang lebih cepat.`;
    } else if (lastError instanceof ModelTimeoutError) {
      errorMsg = `Semua model di ${customName} timeout setelah ${elapsed}s. Terakhir: ${lastError.message}`;
    } else {
      errorMsg = lastError
        ? `Semua model di ${customName} gagal setelah ${elapsed}s. Terakhir: ${lastError.message}`
        : `Semua model di ${customName} gagal setelah ${elapsed}s`;
    }

    stream.push({
      type: 'error',
      reason: 'error',
      error: createErrorMessage(model, errorMsg),
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
