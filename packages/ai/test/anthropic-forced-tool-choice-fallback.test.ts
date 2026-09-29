import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for the lost-subagent-report bug (oh-my-pi fork issue #13): a
 * model the catalog still marks as honoring forced tool use answers a forced
 * `tool_choice` with `400 tool_choice: type "tool" and "any" are not supported
 * for this model.`. The transport must retry that turn exactly once with
 * `tool_choice: auto` plus an instruction naming the tool, complete the turn,
 * and remember the rejection so later forced turns skip the doomed request.
 */

// Opus 4.8 honors forced tool choice in the catalog, so only the runtime
// rejection can trigger the fallback here.
const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const YIELD_TOOL = {
	name: "yield",
	description: "Submit the final report.",
	parameters: { type: "object", properties: { data: { type: "object" } } },
};

const context: Context = {
	systemPrompt: ["You are a subagent."],
	messages: [{ role: "user", content: "Submit your report now.", timestamp: Date.now() }],
	tools: [YIELD_TOOL],
};

const FORCED_YIELD = { type: "tool", name: "yield" } as const;

function forcedToolChoiceRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

function unrelatedRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: text content blocks must be non-empty"},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

const yieldCallEvents = [
	{
		type: "message_start",
		message: {
			id: "msg_yield",
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_yield", name: "yield", input: {} },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '{"data":{"summary":"done"}}' },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use" },
		usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
] as const;

function yieldCallRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of yieldCallEvents) yield event;
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function rejectingRequest(error: Error) {
	return {
		async withResponse() {
			throw error;
		},
	};
}

interface WireBlock {
	type: string;
	text?: string;
}
interface WirePayload {
	tool_choice?: { type: string; name?: string };
	messages: Array<{ role: string; content: string | WireBlock[] }>;
}

function lastUserText(payload: WirePayload): string {
	const last = payload.messages.at(-1);
	if (!last || last.role !== "user") throw new Error("expected a trailing user message");
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/** Mocks the SDK: rejects every request that still forces a tool, answers the rest with a `yield` call. */
function mockApiRejectingForcedToolChoice(payloads: WirePayload[]): void {
	vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
		const payload = structuredClone(params) as WirePayload;
		payloads.push(payload);
		const choice = payload.tool_choice?.type;
		if (choice === "tool" || choice === "any") return rejectingRequest(forcedToolChoiceRejection()) as never;
		return yieldCallRequest() as never;
	});
}

async function runTurn(sessionState: Map<string, ProviderSessionState>, turnContext: Context = context) {
	const stream = streamAnthropic(model, turnContext, {
		apiKey: "sk-test",
		toolChoice: FORCED_YIELD,
		providerSessionState: sessionState,
	});
	for await (const _ of stream) {
		/* drain */
	}
	return stream.result();
}

describe("anthropic-messages forced tool_choice rejection fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries a rejected forced tool_choice once with auto plus a directive naming the tool, and completes", async () => {
		const payloads: WirePayload[] = [];
		mockApiRejectingForcedToolChoice(payloads);

		const result = await runTurn(new Map());

		expect(payloads).toHaveLength(2);
		expect(payloads[0].tool_choice).toEqual({ type: "tool", name: "yield" });
		expect(lastUserText(payloads[0])).not.toContain("`yield`");
		expect(payloads[1].tool_choice).toEqual({ type: "auto" });
		expect(lastUserText(payloads[1])).toContain("Submit your report now.");
		expect(lastUserText(payloads[1])).toContain("`yield`");

		expect(result.stopReason).toBe("toolUse");
		expect(result.disabledFeatures).toContain("forced-tool-choice");
		expect(result.errorMessage).toBeUndefined();
		const toolCall = result.content.find(block => block.type === "toolCall");
		expect(toolCall?.type === "toolCall" && toolCall.name).toBe("yield");
		expect(toolCall?.type === "toolCall" && toolCall.arguments).toEqual({ data: { summary: "done" } });
	});

	it("sends later forced turns of the same session as auto up front", async () => {
		const payloads: WirePayload[] = [];
		mockApiRejectingForcedToolChoice(payloads);
		const sessionState = new Map<string, ProviderSessionState>();

		await runTurn(sessionState);
		const second = await runTurn(sessionState);

		// Two requests for the first turn, a single one for the second.
		expect(payloads).toHaveLength(3);
		expect(payloads[2].tool_choice).toEqual({ type: "auto" });
		expect(lastUserText(payloads[2])).toContain("`yield`");
		expect(second.stopReason).toBe("toolUse");
		expect(second.errorMessage).toBeUndefined();
	});

	it("carries the directive in its own user turn when the conversation has no user turn to extend", async () => {
		const payloads: WirePayload[] = [];
		mockApiRejectingForcedToolChoice(payloads);

		const result = await runTurn(new Map(), { ...context, messages: [] });

		expect(payloads).toHaveLength(2);
		expect(payloads[1].tool_choice).toEqual({ type: "auto" });
		expect(lastUserText(payloads[1])).toContain("`yield`");
		expect(result.errorMessage).toBeUndefined();
	});

	it("does not fall back on an unrelated 400", async () => {
		const payloads: WirePayload[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(structuredClone(params) as WirePayload);
			return rejectingRequest(unrelatedRejection()) as never;
		});

		const result = await runTurn(new Map());

		expect(payloads).toHaveLength(1);
		expect(payloads[0].tool_choice).toEqual({ type: "tool", name: "yield" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("text content blocks must be non-empty");
	});
});
