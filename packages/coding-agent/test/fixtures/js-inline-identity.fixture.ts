/** Isolated detached-parent fixture for the process → Worker → inline fallback contract. */
import { afterEach, expect, it, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	setJsEvalWorkerThreadForTests,
} from "../../src/eval/js/context-manager";
import * as workerClient from "../../src/subprocess/worker-client";

const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker")!;
afterEach(async () => {
	await disposeAllVmContexts();
	Object.defineProperty(globalThis, "Worker", workerDescriptor);
});

it("allows Main inline evaluation under a detached parent but rejects effective child identities", async () => {
	const host = { ...process.env };
	const previousMode = setJsEvalWorkerThreadForTests(false);
	const spawn = spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
		throw new Error("forced subprocess construction failure");
	});
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		value: class {
			constructor() {
				throw new Error("forced Worker construction failure");
			}
		},
	});
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	const run = (agentId?: string) =>
		executeInVmContext({
			sessionKey: `inline-${agentId ?? "absent"}`,
			sessionId: "inline-detached",
			cwd: process.cwd(),
			session,
			agentId,
			sessionFile: agentId ? "/tmp/snapshot.jsonl" : undefined,
			code: "display({ value: 6 * 7 })",
			filename: "inline-main.js",
			runState: {
				onDisplay: output => {
					if (output.type === "json") observed = output.data;
				},
			},
		});
	let observed: unknown;
	try {
		await run(" Main ");
		expect(observed).toEqual({ value: 42 });
		await expect(run("real-child")).rejects.toThrow(
			"Cannot use inline JS eval worker for an identity-bearing session",
		);
		await expect(run()).rejects.toThrow("Cannot use inline JS eval worker for an identity-bearing session");
		expect(spawn).toHaveBeenCalledTimes(3);
		expect(process.env).toEqual(host);
	} finally {
		spawn.mockRestore();
		setJsEvalWorkerThreadForTests(previousMode);
	}
});
