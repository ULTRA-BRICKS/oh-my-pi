import { describe, expect, it } from "bun:test";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";

describe("ExtensionRunner hook identity ctx", () => {
	it("omits reserved Main identity and preserves child identity for omp hook bridges", () => {
		const nested =
			"/tmp/omp-sessions/-xp-rig-cli/2026-09-07T21-17-48-938Z_01a07dbc-040a-7089-9724-7f37bfdba15e/ThinNotSub.jsonl";
		const sessionManager = SessionManager.inMemory("/tmp/project");
		sessionManager.getSessionFile = () => nested;
		let agentId: string | null = "Main";
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			"/tmp/project",
			sessionManager,
			{} as never,
			undefined,
			undefined,
			undefined,
			undefined,
			() => agentId,
		);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => true,
				setLabel: () => {},
				getThinkingLevel: () => "off",
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				getSystemPrompt: () => [],
				compact: async () => {},
			},
		);
		const ctx = runner.createContext();
		expect(ctx.getSessionFile()).toBe(nested);
		expect(ctx.getAgentId()).toBeNull();
		agentId = " Main ";
		expect(ctx.getAgentId()).toBeNull();
		agentId = "ThinNotSub";
		expect(ctx.getAgentId()).toBe("ThinNotSub");
		agentId = " \t ";
		expect(ctx.getAgentId()).toBeNull();
		agentId = null;
		expect(ctx.getAgentId()).toBeNull();
	});
});
