/** Retained Python identity isolation and concurrent-cell contracts, using real runners. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ExecutorBackendExecOptions } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callPythonTool, disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import pythonBackend, { resolvePythonKernelIdentity } from "@oh-my-pi/pi-coding-agent/eval/py/index";
import type { HookIdentity } from "@oh-my-pi/pi-coding-agent/hook-identity-env";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function backendOptions(session: ToolSession, identity: HookIdentity = {}): ExecutorBackendExecOptions {
	return {
		cwd: session.cwd,
		sessionId: "backend-identity",
		sessionFile: identity.sessionFile,
		agentId: identity.agentId,
		kernelOwnerId: "backend-identity-owner",
		reset: false,
		onChunk: () => {},
		session,
		signal: AbortSignal.timeout(5000),
	};
}

describe.skipIf(Bun.env.PI_PYTHON_INTEGRATION !== "1")("retained Python hook identity", () => {
	beforeEach(() => {
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
	});
	afterEach(async () => {
		await disposeAllKernelSessions();
		await disposePyToolBridge();
		vi.restoreAllMocks();
	});

	it("isolates retained variables by agent and transcript while normalizing absent identity", async () => {
		using dir = TempDir.createSync("@python-identity-");
		const options = { cwd: dir.path(), sessionId: "shared", kernelMode: "session" as const, timeoutMs: 5000 };
		const first = { ...options, agentId: "Worker", sessionFile: "/sessions/one.jsonl" };
		expect((await executePython("identity_secret = 42", first)).exitCode).toBe(0);
		for (const identity of [
			{ agentId: "Other", sessionFile: first.sessionFile },
			{ agentId: first.agentId, sessionFile: "/sessions/two.jsonl" },
			{},
		]) {
			const result = await executePython("print('identity_secret' in globals())", { ...options, ...identity });
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("False");
		}
		expect((await executePython("print(identity_secret)", { ...first, agentId: " Worker " })).output.trim()).toBe(
			"42",
		);
		expect((await executePython("main_secret = 7", { ...options, agentId: "Main" })).exitCode).toBe(0);
		expect(
			(await executePython("print(main_secret)", { ...options, agentId: " ", sessionFile: "" })).output.trim(),
		).toBe("7");
	});

	it("does not combine mixed per-call identity with inherited identity", async () => {
		using dir = TempDir.createSync("@python-backend-identity-");
		const session: ToolSession = {
			cwd: dir.path(),
			hasUI: false,
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			getEvalSessionId: () => "backend-identity",
			getEvalKernelOwnerId: () => "backend-identity-owner",
			getAgentId: () => "Worker",
			getSessionFile: () => "/sessions/inherited.jsonl",
			getSessionSpawns: () => null,
		};
		const run = async (code: string, identity: HookIdentity = {}) => {
			const result = await pythonBackend.execute(code, backendOptions(session, identity));
			expect(result.exitCode).toBe(0);
			return result.output.trim();
		};

		await run("unowned_secret = 7", { agentId: "Main", sessionFile: "/sessions/main.jsonl" });
		expect(await run("print(unowned_secret)", { sessionFile: "/sessions/session-only.jsonl" })).toBe("7");

		await run("child_secret = 11", { agentId: "Other", sessionFile: "/sessions/inherited.jsonl" });
		expect(await run("print('child_secret' in globals())", { agentId: "Other" })).toBe("False");
	});

	it("invokes the tool retained under the owning transcript identity", async () => {
		using dir = TempDir.createSync("@python-tool-identity-");
		const session: ToolSession = {
			cwd: dir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionSpawns: () => "",
			getAgentId: () => "Worker",
			getSessionFile: () => "/sessions/tools.jsonl",
		};
		const identity = resolvePythonKernelIdentity(session);
		const defined = await executePython("@tool\ndef answer() -> int:\n    return 42", {
			...identity,
			kernelMode: "session",
			timeoutMs: 5000,
		});
		expect(defined.exitCode).toBe(0);
		expect(await callPythonTool("answer", {}, { ...identity, toolSession: session })).toEqual({
			ok: true,
			value: 42,
		});
	});

	it("lets a same-identity cell release an awaiting retained cell", async () => {
		using dir = TempDir.createSync("@python-interleaving-");
		const options = {
			cwd: dir.path(),
			sessionId: "shared",
			agentId: "Worker",
			kernelMode: "session" as const,
			timeoutMs: 5000,
		};
		const ready = Promise.withResolvers<void>();
		const waiting = executePython(
			"import asyncio\nrelease = asyncio.Event()\nprint('ready', flush=True)\nawait release.wait()\nprint('released')",
			{
				...options,
				onChunk: chunk => {
					if (chunk.includes("ready")) ready.resolve();
				},
			},
		);
		await Promise.race([
			ready.promise,
			waiting.then(() => {
				throw new Error("Cell ended before ready");
			}),
		]);
		const release = await executePython("release.set()", options);
		const result = await waiting;
		expect(release.exitCode).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("released");
	});
});
