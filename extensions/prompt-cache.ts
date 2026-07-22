import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Testing seam — allow tests to inject a crypto substitute
// ---------------------------------------------------------------------------

let _crypto: { createHash: typeof createHash } = { createHash };

export const _setCryptoForTesting = (c: typeof _crypto): void => {
	_crypto = c;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect whether payload looks like Anthropic or OpenAI format. */
type PayloadFormat = "anthropic-messages" | "openai-completions" | "unknown";

function detectFormat(payload: Record<string, unknown>): PayloadFormat {
	// Anthropic: system can be string or array of content blocks
	if (payload.system !== undefined) return "anthropic-messages";
	if (Array.isArray(payload.messages)) return "openai-completions";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Cache-Control stripping (re-stamp before each request)
// ---------------------------------------------------------------------------

/** Remove cache_control from all messages/content blocks before re-stamping. */
function stripStaleCacheControl(payload: Record<string, unknown>): void {
	// Strip top-level cache keys too
	delete payload.prompt_cache_key;
	delete payload.prompt_cache_retention;

	if (Array.isArray(payload.messages)) {
		for (const msg of payload.messages) {
			if (typeof msg !== "object" || msg === null) continue;
			const m = msg as Record<string, unknown>;
			delete m.cache_control;

			if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (typeof block === "object" && block !== null) {
						delete (block as Record<string, unknown>).cache_control;
					}
				}
			}
		}
	}

	if (Array.isArray(payload.system)) {
		for (const block of payload.system) {
			if (typeof block === "object" && block !== null) {
				delete (block as Record<string, unknown>).cache_control;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// OpenAI stamping
// ---------------------------------------------------------------------------

function getSystemText(payload: Record<string, unknown>): string | undefined {
	if (typeof payload.system === "string") {
		return payload.system;
	}
	// For OpenAI format, find system/developer message
	if (Array.isArray(payload.messages)) {
		const sys = payload.messages.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				((m as Record<string, unknown>).role === "system" ||
				 (m as Record<string, unknown>).role === "developer"),
		);
		if (sys && typeof (sys as Record<string, unknown>).content === "string") {
			return (sys as Record<string, unknown>).content as string;
		}
	}
	return undefined;
}

export function computePromptCacheKey(
	payload: Record<string, unknown>,
): string | undefined {
	const text = getSystemText(payload);
	if (!text) return undefined;
	return _crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function stampOpenAiCacheControl(payload: Record<string, unknown>): void {
	const messages = payload.messages as
		| Array<Record<string, unknown>>
		| undefined;
	if (!messages || messages.length <= 1) return;

	// First system/developer message
	const sysMsg = messages.find(
		(m) =>
			typeof m === "object" &&
			m !== null &&
			(m.role === "system" || m.role === "developer"),
	);
	if (sysMsg) sysMsg.cache_control = { type: "ephemeral" };

	// Last user message
	const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
	if (lastUserIdx !== -1) {
		messages[lastUserIdx].cache_control = { type: "ephemeral" };
	}

	// Top-level key
	payload.prompt_cache_key = computePromptCacheKey(payload);
	payload.prompt_cache_retention = "24h";

	// Last tool definition
	if (Array.isArray(payload.tools) && payload.tools.length > 0) {
		const lastTool = payload.tools[payload.tools.length - 1];
		if (typeof lastTool === "object" && lastTool !== null) {
			(lastTool as Record<string, unknown>).cache_control = {
				type: "ephemeral",
			};
		}
	}
}



// ---------------------------------------------------------------------------
// Anthropic stamping
// ---------------------------------------------------------------------------

function stampAnthropicCacheControl(payload: Record<string, unknown>): void {
	// First 2 text blocks in system array
	if (Array.isArray(payload.system)) {
		let stamped = 0;
		for (const block of payload.system) {
			if (stamped >= 2) break;
			if (
				typeof block === "object" &&
				block !== null &&
				(block as Record<string, unknown>).type === "text"
			) {
				(block as Record<string, unknown>).cache_control = {
					type: "ephemeral",
				};
				stamped++;
			}
		}
	}

	// Last text content block in last user message
	const messages = payload.messages as
		| Array<Record<string, unknown>>
		| undefined;
	if (messages) {
		const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
		if (lastUserIdx !== -1) {
			const userMsg = messages[lastUserIdx];
			const content = userMsg.content as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(content)) {
				const lastTextIdx = content.findLastIndex((b) => b.type === "text");
				if (lastTextIdx !== -1) {
					content[lastTextIdx].cache_control = { type: "ephemeral" };
				}
			}
		}
	}

	// Last tool definition
	if (Array.isArray(payload.tools) && payload.tools.length > 0) {
		const lastTool = payload.tools[payload.tools.length - 1];
		if (typeof lastTool === "object" && lastTool !== null) {
			(lastTool as Record<string, unknown>).cache_control = {
				type: "ephemeral",
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

/**
 * `before_provider_request` hook.
 *
 * Detects payload format (Anthropic vs OpenAI), strips stale cache_control
 * markers, and stamps fresh ones.
 */
export function beforeProviderRequest(payload: unknown, _ctx: unknown): void {
	if (typeof payload !== "object" || payload === null) return;

	const p = payload as Record<string, unknown>;

	// Skip GLM and Zhipu models
	const model = p.model as string | undefined;
	if (model && (model.startsWith("glm/") || model.startsWith("zhipu/"))) return;

	const format = detectFormat(p);
	if (format === "unknown") return;

	stripStaleCacheControl(p);

	if (format === "openai-completions") {
		stampOpenAiCacheControl(p);
	} else {
		stampAnthropicCacheControl(p);
	}
}
