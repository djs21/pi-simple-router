import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
	beforeProviderRequest,
	computePromptCacheKey,
	_setCryptoForTesting,
} from "./prompt-cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sha256 = (text: string) =>
	createHash("sha256").update(text, "utf-8").digest("hex");

function makeOpenAiPayload(overrides: Record<string, unknown> = {}): any {
	return {
		model: "openai/gpt-4",
		messages: [
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: "Hello" },
			{ role: "user", content: "World" },
		],
		...overrides,
	};
}

function makeAnthropicPayload(overrides: Record<string, unknown> = {}): any {
	return {
		model: "anthropic/claude-3",
		system: [{ type: "text", text: "You are Claude." }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "World" },
					{ type: "text", text: "!" },
				],
			},
		],
		...overrides,
	};
}

beforeEach(() => {
	_setCryptoForTesting({ createHash });
});

// ---------------------------------------------------------------------------
// stripStaleCacheControl
// ---------------------------------------------------------------------------

describe("stripStaleCacheControl", () => {
	it("strips cache_control from all messages and content blocks", () => {
		const payload = makeOpenAiPayload();
		payload.messages[0].cache_control = { type: "ephemeral" };
		payload.messages[1].cache_control = { type: "ephemeral" };
		payload.messages[2].content = [
			{ type: "text", text: "stale", cache_control: { type: "ephemeral" } },
		];

		beforeProviderRequest(payload, undefined as any);

		// messages[1] is middle user — stamp won't re-add here (only last user gets it)
		expect(payload.messages[1].cache_control).toBeUndefined();
		// content blocks don't get cache_control in OpenAI format (only Anthropic)
		expect(payload.messages[2].content[0].cache_control).toBeUndefined();
		// messages[2] (last user) should get re-stamped fresh
		expect(payload.messages[2].cache_control).toEqual({ type: "ephemeral" });
	});

	it("strips cache_control from Anthropic system array blocks", () => {
		const payload = makeAnthropicPayload();
		// Inject stale on message content (won't be re-stamped by stampAnthropicCacheControl
		// since it only stamps the first 2 system text blocks and last text in last user)
		payload.messages[0].content[0].cache_control = { type: "ephemeral" };

		beforeProviderRequest(payload, undefined as any);

		// user content blocks beyond the last text don't get cache_control re-stamped
		expect(payload.messages[0].content[0].cache_control).toBeUndefined();
		// system[0] gets re-stamped by stampAnthropicCacheControl
		expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
	});
});

// ---------------------------------------------------------------------------
// stampOpenAiCacheControl
// ---------------------------------------------------------------------------

describe("stampOpenAiCacheControl", () => {
	it("stamps system + last user + prompt_cache_key + retention", () => {
		const payload = makeOpenAiPayload();
		beforeProviderRequest(payload, undefined as any);

		expect(payload.messages[0].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.messages[2].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.messages[1].cache_control).toBeUndefined();
		expect(payload.prompt_cache_key).toBe(
			sha256("You are a helpful assistant."),
		);
		expect(payload.prompt_cache_retention).toBe("24h");
	});

	it("skips single-message requests", () => {
		const payload: any = {
			model: "openai/gpt-4",
			messages: [{ role: "user", content: "Just one message" }],
		};
		beforeProviderRequest(payload, undefined as any);

		expect(payload.messages[0].cache_control).toBeUndefined();
		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("stamps last tool definition", () => {
		const payload = makeOpenAiPayload({
			tools: [
				{ type: "function", function: { name: "tool_a" } },
				{ type: "function", function: { name: "tool_b" } },
			],
		});
		beforeProviderRequest(payload, undefined as any);

		expect(payload.tools[1].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.tools[0].cache_control).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// stampAnthropicCacheControl
// ---------------------------------------------------------------------------

describe("stampAnthropicCacheControl", () => {
	it("adds cache_control to first 2 system text blocks and last user text block", () => {
		const payload = makeAnthropicPayload();
		beforeProviderRequest(payload, undefined as any);

		expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });

		const lastUserMsg = payload.messages[2];
		const textBlocks = lastUserMsg.content.filter(
			(b: any) => b.type === "text",
		);
		expect(textBlocks[textBlocks.length - 1].cache_control).toEqual({
			type: "ephemeral",
		});
	});

	it("stamps last tool definition", () => {
		const payload = makeAnthropicPayload({
			tools: [
				{ name: "tool_a", input_schema: {} },
				{ name: "tool_b", input_schema: {} },
			],
		});
		beforeProviderRequest(payload, undefined as any);

		expect(payload.tools[1].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.tools[0].cache_control).toBeUndefined();
	});
	it("stamps first 2 of 3+ system text blocks only", () => {
		const payload = makeAnthropicPayload({
			system: [
				{ type: "text", text: "Block 1" },
				{ type: "text", text: "Block 2" },
				{ type: "text", text: "Block 3" },
			],
		});
		beforeProviderRequest(payload, undefined as any);

		expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.system[1].cache_control).toEqual({ type: "ephemeral" });
		expect(payload.system[2].cache_control).toBeUndefined();
	});
});
// ---------------------------------------------------------------------------
// computePromptCacheKey
// ---------------------------------------------------------------------------

describe("computePromptCacheKey", () => {
	it("returns SHA-256 hex of system text", () => {
		const payload = makeOpenAiPayload();
		expect(computePromptCacheKey(payload)).toBe(
			sha256("You are a helpful assistant."),
		);
	});

	it("returns undefined when no system message", () => {
		const payload: any = {
			model: "openai/gpt-4",
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(computePromptCacheKey(payload)).toBeUndefined();
	});

	it("works with Anthropic system string", () => {
		const payload: any = { model: "anthropic/claude-3", system: "Be brief." };
		expect(computePromptCacheKey(payload)).toBe(sha256("Be brief."));
	});
});

// ---------------------------------------------------------------------------
// beforeProviderRequest — format detection & model skip
// ---------------------------------------------------------------------------

describe("beforeProviderRequest", () => {
	it("skips glm models", () => {
		const payload: any = {
			model: "glm/glm-4",
			messages: [
				{ role: "user", content: "Hi" },
				{ role: "user", content: "Bye" },
			],
		};
		beforeProviderRequest(payload, undefined as any);

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.messages[0].cache_control).toBeUndefined();
		expect(payload.messages[1].cache_control).toBeUndefined();
	});

	it("skips zhipu models", () => {
		const payload: any = {
			model: "zhipu/glm-4",
			messages: [
				{ role: "user", content: "Hi" },
				{ role: "user", content: "Bye" },
			],
		};
		beforeProviderRequest(payload, undefined as any);

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.messages[0].cache_control).toBeUndefined();
	});

	it("passes through unknown format", () => {
		const payload: any = {
			model: "custom/model",
			custom_field: "value",
		};
		beforeProviderRequest(payload, undefined as any);
		expect(payload).toEqual({
			model: "custom/model",
			custom_field: "value",
		});
	});
});
