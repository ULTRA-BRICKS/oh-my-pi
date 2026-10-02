/** Retained JS state must follow normalized agent/transcript identity across backend calls. */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ExecutorBackendExecOptions, ExecutorBackendResult } from "../../src/eval/backend";
import jsBackend from "../../src/eval/js";
import {
	disposeAllVmContexts,
	disposeVmContextsByOwner,
	setJsEvalWorkerThreadForTests,
} from "../../src/eval/js/context-manager";
import * as workerClient from "../../src/subprocess/worker-client";
import type { HookIdentity } from "../../src/hook-identity-env";
import { describeEvalTools } from "../../src/task/eval-tools";
import type { ToolSession } from "../../src/tools";

const identityKeys = [
	"RIG_AGENT_ID",
	"PI_SESSION_FILE",
	"RIG_DETACHED_AGENT",
	"OMP_INTERNAL_PARENT_RIG_AGENT_ID",
	"OMP_INTERNAL_PARENT_PI_SESSION_FILE",
] as const;

type IdentityValues = Record<(typeof identityKeys)[number], string | null>;

interface IdentityObservation {
	codeRan: true;
	process: IdentityValues;
	helper: IdentityValues;
	child: IdentityValues;
}

function isIdentityObservation(value: unknown): value is IdentityObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const codeRan = Reflect.get(value, "codeRan");
	const process = Reflect.get(value, "process");
	const helper = Reflect.get(value, "helper");
	const child = Reflect.get(value, "child");
	const isIdentityValues = (candidate: unknown): candidate is IdentityValues => {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		return identityKeys.every(key => {
			const field = Reflect.get(candidate, key);
			return typeof field === "string" || field === null;
		});
	};
	return codeRan === true && isIdentityValues(process) && isIdentityValues(helper) && isIdentityValues(child);
}

function getIdentityObservation(result: ExecutorBackendResult): IdentityObservation {
	const output = result.displayOutputs.find(output => output.type === "json");
	if (!output || output.type !== "json" || !isIdentityObservation(output.data)) {
		throw new Error("JavaScript backend identity probe returned an invalid observation");
	}
	return output.data;
}
function options(identity: HookIdentity = {}): ExecutorBackendExecOptions {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getEvalSessionId: () => "shared-identity-regression",
		getEvalKernelOwnerId: () => "shared-owner",
		getAgentId: () => identity.agentId ?? null,
		getSessionFile: () => identity.sessionFile ?? null,
		getSessionSpawns: () => null,
	};
	return {
		cwd: session.cwd,
		sessionId: "shared-identity-regression",
		session,
		sessionFile: identity.sessionFile,
		agentId: identity.agentId,
		kernelOwnerId: "shared-owner",
		reset: false,
		onChunk: () => {},
		signal: AbortSignal.timeout(15_000),
	};
}

async function run(code: string, opts: ExecutorBackendExecOptions): Promise<string> {
	const result = await jsBackend.execute(code, opts);
	expect(result.exitCode).toBe(0);
	return result.output.trim();
}

describe("retained JS kernel identity", () => {
	afterEach(disposeAllVmContexts);

	it("suppresses explicit Main identity under detached parent markers after both worker fallbacks fail", async () => {
		const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		const savedEnv = identityKeys.map(key => ({ key, value: process.env[key] }));
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(false);
		const spawn = vi.spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
			throw new Error("forced subprocess construction failure");
		});
		try {
			Object.defineProperty(globalThis, "Worker", {
				configurable: true,
				value: class {
					constructor() {
						throw new Error("forced Bun Worker construction failure");
					}
				},
			});
			for (const key of identityKeys) process.env[key] = "detached-parent";
			process.env.RIG_DETACHED_AGENT = "1";
			const result = await jsBackend.execute(
				`
				const keys = ${JSON.stringify(identityKeys)};
				const read = source => Object.fromEntries(keys.map(key => [key, source[key] ?? null]));
				const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(identityKeys)}.map(key => [key, process.env[key] ?? null]))))`)}], {
					env: process.env, stdout: "pipe", stderr: "pipe",
				});
				const childIdentity = JSON.parse(await new Response(child.stdout).text());
				if (await child.exited !== 0) throw new Error("Identity child failed");
				display({ codeRan: true, process: read(process.env), helper: read(env()), child: childIdentity });
				`,
				options({ agentId: " Main ", sessionFile: "/tmp/main.jsonl" }),
			);
			expect(result.exitCode).toBe(0);
			const observation = getIdentityObservation(result);
			expect(observation.codeRan).toBe(true);
			for (const source of [observation.process, observation.helper, observation.child]) {
				for (const key of identityKeys) expect(source[key]).toBeNull();
			}
		} finally {
			await disposeAllVmContexts();
			for (const { key, value } of savedEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
			else Reflect.deleteProperty(globalThis, "Worker");
			spawn.mockRestore();
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	}, 20_000);

	it("isolates settled A, B, other-transcript and absent state while retaining normalized identities", async () => {
		const a = options({ agentId: " A ", sessionFile: " /tmp/shared.jsonl " });
		await run("globalThis.secret = 11", a);
		const b = options({ agentId: "B", sessionFile: "/tmp/shared.jsonl" });
		expect(await run("return typeof secret", b)).toBe("undefined");
		await run("globalThis.secret = 22", b);
		const other = options({ agentId: "B", sessionFile: "/tmp/other.jsonl" });
		expect(await run("return typeof secret", other)).toBe("undefined");
		await run("globalThis.secret = 33", other);
		expect(await run("return typeof secret", options())).toBe("undefined");
		await run("globalThis.secret = 44", options());
		expect(await run("return secret", options({ agentId: " Main ", sessionFile: "/tmp/main.jsonl" }))).toBe("44");
		expect(await run("return secret", options({ agentId: " ", sessionFile: " " }))).toBe("44");
		expect(await run("return secret", options({ agentId: "A", sessionFile: "/tmp/shared.jsonl" }))).toBe("11");
		expect(await run("return secret", b)).toBe("22");
		expect(await run("return secret", other)).toBe("33");
	}, 20_000);

	it("uses per-call identity overrides and lets task tool discovery find session-owned tools", async () => {
		const a = options({ agentId: "A", sessionFile: "/tmp/tools.jsonl" });
		await run('tool(() => 42, { name: "answer" })', a);
		expect((await describeEvalTools(a.session, ["answer"])).map(tool => tool.name)).toEqual(["answer"]);
		await run("globalThis.secret = 7", a);
		expect(await run("return secret", { ...a, agentId: undefined, sessionFile: undefined })).toBe("7");
		expect(await run("return typeof secret", { ...a, agentId: "B" })).toBe("undefined");
		expect(await run("return typeof secret", { ...a, sessionFile: "/tmp/other.jsonl" })).toBe("undefined");
	}, 20_000);

	it("preserves shared-owner reset forks and disposes only the requesting owner's contexts", async () => {
		const a = options({ agentId: "A", sessionFile: "/tmp/owners.jsonl" });
		const b = { ...a, session: { ...a.session, getEvalKernelOwnerId: () => "other-owner" } };
		await run("globalThis.secret = 9", a);
		expect(await run("return secret", b)).toBe("9");
		expect(await run("return typeof secret", { ...b, reset: true })).toBe("undefined");
		await run("globalThis.secret = 12", b);
		expect(await run("return secret", a)).toBe("9");
		expect(await run("return secret", b)).toBe("12");
		await disposeVmContextsByOwner("other-owner");
		expect(await run("return secret", a)).toBe("9");
		expect(await run("return typeof secret", { ...a, reset: true })).toBe("undefined");
	}, 20_000);

	it("lets an overlapping cell with the same normalized identity release a retained cell", async () => {
		const ready = Promise.withResolvers<void>();
		const a = options({ agentId: " A ", sessionFile: " /tmp/concurrent.jsonl " });
		const first = run(
			'await new Promise(resolve => { globalThis.release = resolve; console.log("ready"); }); return 42',
			{
				...a,
				onChunk: chunk => {
					if (chunk.includes("ready")) ready.resolve();
				},
			},
		);
		await Promise.race([
			ready.promise,
			first.then(() => {
				throw new Error("Cell ended before release");
			}),
		]);
		await run("release()", options({ agentId: "A", sessionFile: "/tmp/concurrent.jsonl" }));
		expect(await first).toContain("42");
	}, 20_000);
});
