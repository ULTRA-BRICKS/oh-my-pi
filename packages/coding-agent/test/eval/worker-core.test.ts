import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";
import { buildHookIdentityWorkerEnv } from "../../src/hook-identity-env";

interface WorkerHarness {
	send(message: WorkerInbound): void;
	onMessage(handler: (message: WorkerOutbound) => void): () => void;
}

function createWorkerHarness(mode: "inline" | "isolated" = "inline"): WorkerHarness {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const transport: Transport = {
		send: message => {
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(message);
			});
		},
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	new WorkerCore(transport, {
		mode,
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		send(message) {
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(message);
			});
		},
		onMessage(handler) {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
	};
}

function waitForMessage(
	harness: WorkerHarness,
	predicate: (message: WorkerOutbound) => boolean,
): Promise<WorkerOutbound> {
	const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
	let unsubscribe = (): void => {};
	unsubscribe = harness.onMessage(message => {
		if (!predicate(message)) return;
		unsubscribe();
		resolve(message);
	});
	return promise;
}

async function initializeWorker(harness: WorkerHarness, snapshot: SessionSnapshot): Promise<void> {
	const ready = waitForMessage(harness, message => message.type === "ready" || message.type === "init-failed");
	harness.send({ type: "init", snapshot });
	expect(await ready).toEqual({ type: "ready" });
}

function installFatalCapture(): {
	fatal: unknown[];
	uninstall: () => void;
} {
	const fatal: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		fatal.push(reason);
	};
	const onUncaught = (err: Error): void => {
		fatal.push(err);
	};
	process.on("unhandledRejection", onUnhandled);
	process.on("uncaughtException", onUncaught);
	return {
		fatal,
		uninstall: () => {
			process.off("unhandledRejection", onUnhandled);
			process.off("uncaughtException", onUncaught);
		},
	};
}

describe("WorkerCore", () => {
	const identityKeys = [
		"PI_SESSION_FILE",
		"RIG_AGENT_ID",
		"RIG_DETACHED_AGENT",
		"OMP_INTERNAL_PARENT_PI_SESSION_FILE",
		"OMP_INTERNAL_PARENT_RIG_AGENT_ID",
	] as const;
	let inheritedEnv: NodeJS.ProcessEnv;
	beforeEach(() => {
		inheritedEnv = { ...process.env };
		for (const key of identityKeys) delete process.env[key];
	});
	afterEach(() => {
		for (const key of identityKeys) {
			const value = inheritedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	it("reports same-realm cwd conflicts through the worker protocol", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "same-realm-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "same-realm-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		const held = waitForMessage(
			first,
			message => message.type === "result" && message.runId === "hold-first-runtime",
		);
		try {
			first.send({
				type: "run",
				runId: "hold-first-runtime",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[same-realm-first].js",
				snapshot: { cwd, sessionId: "same-realm-first", localRoots: {} },
			});
			await entered.promise;

			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second-runtime",
			);
			second.send({
				type: "run",
				runId: "overlap-second-runtime",
				code: "1 + 1;",
				filename: "[same-realm-second].js",
				snapshot: { cwd, sessionId: "same-realm-second", localRoots: {} },
			});

			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-second-runtime",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
		} finally {
			gate.resolve();
			await held;
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});
	it("rejects a differing effective identity before overlapping run mutation", async () => {
		const harness = createWorkerHarness("isolated");
		const cwd = process.cwd();
		await initializeWorker(harness, {
			cwd,
			sessionId: "identity-overlap",
			sessionFile: "/tmp/identity-a.jsonl",
			agentId: "identity-a",
			localRoots: {},
		});
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		Reflect.set(globalThis, "__omp_worker_identity_gate", {
			entered: () => entered.resolve(),
			wait: gate.promise,
		});
		try {
			const held = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "identity-hold",
			);
			harness.send({
				type: "run",
				runId: "identity-hold",
				code: `globalThis.__omp_worker_identity_gate.entered(); await globalThis.__omp_worker_identity_gate.wait;
					if (process.env.RIG_AGENT_ID !== "identity-a" || env("RIG_AGENT_ID") !== "identity-a" ||
						process.env.PI_SESSION_FILE !== "/tmp/identity-a.jsonl" || env("PI_SESSION_FILE") !== "/tmp/identity-a.jsonl") {
						throw new Error("active run identity changed");
					}`,
				filename: "[identity-hold].js",
				snapshot: {
					cwd,
					sessionId: "identity-overlap",
					sessionFile: "/tmp/identity-a.jsonl",
					agentId: "identity-a",
					localRoots: {},
				},
			});
			await entered.promise;

			const differing = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "identity-differing",
			);
			harness.send({
				type: "run",
				runId: "identity-differing",
				code: "process.env.RIG_AGENT_ID;",
				filename: "[identity-differing].js",
				snapshot: {
					cwd,
					sessionId: "identity-overlap",
					sessionFile: "/tmp/identity-b.jsonl",
					agentId: "identity-b",
					localRoots: {},
				},
			});
			expect(await differing).toMatchObject({
				type: "result",
				runId: "identity-differing",
				ok: false,
				error: {
					name: "ToolError",
					message: "Cannot run JS eval with a different effective identity while another run is active",
				},
			});

			expect(process.env.RIG_AGENT_ID).toBe("identity-a");
			expect(process.env.PI_SESSION_FILE).toBe("/tmp/identity-a.jsonl");
			const absent = waitForMessage(harness, message => message.type === "result" && message.runId === "absent");
			harness.send({
				type: "run",
				runId: "absent",
				code: "throw new Error('must not execute')",
				filename: "[absent].js",
				snapshot: { cwd, sessionId: "identity-overlap" },
			});
			expect(await absent).toMatchObject({
				type: "result",
				ok: false,
				error: {
					name: "ToolError",
					message: "Cannot run JS eval with a different effective identity while another run is active",
				},
			});
			const same = waitForMessage(harness, message => message.type === "result" && message.runId === "same");
			harness.send({
				type: "run",
				runId: "same",
				code: "1 + 1",
				filename: "[same].js",
				snapshot: {
					cwd,
					sessionId: "identity-overlap",
					agentId: "identity-a",
					sessionFile: "/tmp/identity-a.jsonl",
				},
			});
			expect(await same).toMatchObject({ type: "result", ok: true });
			const rejectedInit = waitForMessage(harness, message => message.type === "init-failed");
			harness.send({ type: "init", snapshot: { cwd, sessionId: "identity-overlap", agentId: "identity-b" } });
			expect(await rejectedInit).toMatchObject({ type: "init-failed", error: { name: "ToolError" } });
			expect(process.env.RIG_AGENT_ID).toBe("identity-a");
			expect(process.env.PI_SESSION_FILE).toBe("/tmp/identity-a.jsonl");
			gate.resolve();
			expect(await held).toMatchObject({ type: "result", ok: true });
		} finally {
			gate.resolve();
			Reflect.deleteProperty(globalThis, "__omp_worker_identity_gate");
			harness.send({ type: "close" });
		}
	});

	it.each([false, true])("refreshes raw and helper identity sequentially with detached=%s", async detached => {
		process.env.RIG_AGENT_ID = "untrusted-parent";
		process.env.PI_SESSION_FILE = "/tmp/untrusted.jsonl";
		if (detached) process.env.RIG_DETACHED_AGENT = "1";
		const harness = createWorkerHarness("isolated");
		const base = { cwd: process.cwd(), sessionId: "sequential-identity" };
		try {
			await initializeWorker(harness, base);
			for (const identity of [
				{ agentId: "identity-a", sessionFile: "/tmp/a.jsonl" },
				{ agentId: "identity-b", sessionFile: "/tmp/b.jsonl" },
				{ agentId: "Main", sessionFile: "/tmp/Main.jsonl" },
				{},
			]) {
				const snapshot: SessionSnapshot = { ...base, ...identity };
				const expectedAgent =
					snapshot.agentId === "Main" ? null : (snapshot.agentId ?? (detached ? "untrusted-parent" : null));
				const expectedSession =
					snapshot.agentId === "Main"
						? null
						: (snapshot.sessionFile ?? (detached ? "/tmp/untrusted.jsonl" : null));
				const result = waitForMessage(harness, message => message.type === "result");
				harness.send({
					type: "run",
					runId: "sequential",
					filename: "[sequential].js",
					snapshot,
					code: `if ((process.env.RIG_AGENT_ID ?? null) !== ${JSON.stringify(expectedAgent)} ||
						(env("RIG_AGENT_ID") ?? null) !== ${JSON.stringify(expectedAgent)} ||
						(process.env.PI_SESSION_FILE ?? null) !== ${JSON.stringify(expectedSession)} ||
						(env("PI_SESSION_FILE") ?? null) !== ${JSON.stringify(expectedSession)}) {
						throw new Error("identity mismatch");
					}`,
				});
				expect(await result).toMatchObject({ type: "result", ok: true });
			}
		} finally {
			harness.send({ type: "close" });
		}
	});

	it.each(["1", "0"])("removes worker carriers from raw and child env with detached=%s", async detached => {
		const explicit = { agentId: "explicit-agent", sessionFile: "/tmp/explicit.jsonl" };
		Object.assign(
			process.env,
			buildHookIdentityWorkerEnv(
				{
					RIG_DETACHED_AGENT: detached,
					RIG_AGENT_ID: "parent-agent",
					PI_SESSION_FILE: "/tmp/parent.jsonl",
				},
				explicit,
			),
		);
		// Even untrusted carriers must not remain visible to evaluated code or children.
		process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE = "/tmp/parent.jsonl";
		process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID = "parent-agent";
		const harness = createWorkerHarness("isolated");
		const base = { cwd: process.cwd(), sessionId: "carrier-cleanup" };
		const readEnv = `JSON.stringify([
			process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE ?? null,
			process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID ?? null,
			process.env.PI_SESSION_FILE ?? null,
			process.env.RIG_AGENT_ID ?? null,
			process.env.RIG_DETACHED_AGENT ?? null,
		])`;
		try {
			expect(process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE).toBeUndefined();
			expect(process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID).toBeUndefined();
			await initializeWorker(harness, { ...base, ...explicit });
			expect(process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE).toBeUndefined();
			expect(process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID).toBeUndefined();
			for (const identity of [explicit, {}]) {
				const expected = JSON.stringify([
					null,
					null,
					"sessionFile" in identity ? identity.sessionFile : detached === "1" ? "/tmp/parent.jsonl" : null,
					"agentId" in identity ? identity.agentId : detached === "1" ? "parent-agent" : null,
					detached,
				]);
				const result = waitForMessage(harness, message => message.type === "result");
				harness.send({
					type: "run",
					runId: "carrier-check",
					filename: "[carrier-check].js",
					snapshot: { ...base, ...identity },
					code: `const expected = ${JSON.stringify(expected)};
						if (${readEnv} !== expected) throw new Error("raw worker env leaked carriers or lost identity");
						const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`process.stdout.write(${readEnv})`)}], {
							stdout: "pipe", stderr: "pipe", env: { ...process.env },
						});
						const output = await new Response(child.stdout).text();
						const stderr = await new Response(child.stderr).text();
						const exitCode = await child.exited;
						if (exitCode !== 0 || output !== expected) throw new Error("child env mismatch: " + JSON.stringify({ output, expected, stderr, exitCode }));`,
				});
				expect(await result).toMatchObject({ type: "result", ok: true });
				expect(process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE).toBeUndefined();
				expect(process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID).toBeUndefined();
			}
		} finally {
			harness.send({ type: "close" });
		}
	});

	it("allows inline execution with untrusted stale host markers but rejects explicit identity", async () => {
		process.env.RIG_AGENT_ID = "stale-host-agent";
		process.env.PI_SESSION_FILE = "   ";
		process.env.RIG_DETACHED_AGENT = "0";
		const hostEnv = { ...process.env };
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "inline-stale-host" };
		try {
			await initializeWorker(harness, snapshot);
			const result = waitForMessage(harness, message => message.type === "result");
			harness.send({ type: "run", runId: "stale-host", code: "1 + 1", filename: "[stale-host].js", snapshot });
			expect(await result).toMatchObject({ type: "result", ok: true });
			expect(process.env).toEqual(hostEnv);
			const rejected = waitForMessage(harness, message => message.type === "result");
			harness.send({
				type: "run",
				runId: "explicit-identity",
				code: "1 + 1",
				filename: "[explicit-identity].js",
				snapshot: { ...snapshot, agentId: "native-agent" },
			});
			expect(await rejected).toMatchObject({ type: "result", ok: false, error: { name: "ToolError" } });
			expect(process.env).toEqual(hostEnv);
		} finally {
			harness.send({ type: "close" });
		}
	});

	it("suppresses host identity throughout poisoned retained-tool registry access", async () => {
		process.env.RIG_AGENT_ID = "host-agent";
		process.env.PI_SESSION_FILE = "/tmp/host.jsonl";
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "inline-poisoned-registry" };
		const setup = waitForMessage(harness, message => message.type === "result" && message.runId === "poisoned-setup");
		try {
			await initializeWorker(harness, snapshot);
			harness.send({
				type: "run",
				runId: "poisoned-setup",
				code: `
					const observations = [];
					const capture = label => {
						const observation = {
							label,
							processAgent: process.env.RIG_AGENT_ID ?? null,
							processSession: process.env.PI_SESSION_FILE ?? null,
							helperAgent: env("RIG_AGENT_ID") ?? null,
							helperSession: env("PI_SESSION_FILE") ?? null,
						};
						observations.push(observation);
						return observation;
					};
					const spec = {
						get name() {
							capture("describe-name");
							return "poisoned";
						},
						get description() {
							capture("describe-description");
							return "poisoned";
						},
						get parameters() {
							capture("describe-parameters");
							return { type: "object" };
						},
						get fn() {
							capture("dispatch-fn");
							return () => {
								capture("dispatch-callback");
								return {
									get marker() {
										return capture("dispatch-clone");
									},
								};
							};
						},
					};
					let registry = new Map([["poisoned", spec]]);
					registry[Symbol.iterator] = function* () {
						capture("registry-iterator");
						yield* Map.prototype[Symbol.iterator].call(this);
					};
					Object.defineProperty(globalThis, "__omp_tools__", {
						configurable: true,
						get() {
							capture("registry-getter");
							return registry;
						},
						set(value) {
							for (const [name, tool] of value) registry.set(name, tool);
						},
					});
					globalThis.__omp_poisoned_observations = observations;
				`,
				filename: "[poisoned-setup].js",
				snapshot,
			});
			expect(await setup).toMatchObject({ type: "result", runId: "poisoned-setup", ok: true });

			const described = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "poisoned-describe",
			);
			harness.send({
				type: "tool",
				runId: "poisoned-describe",
				op: "describe",
				names: ["poisoned"],
			});
			expect(await described).toMatchObject({ type: "result", runId: "poisoned-describe", ok: true });

			const called = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "poisoned-call",
			);
			harness.send({
				type: "tool",
				runId: "poisoned-call",
				op: "call",
				name: "poisoned",
				args: {},
			});
			expect(await called).toMatchObject({ type: "result", runId: "poisoned-call", ok: true });

			const observed = waitForMessage(
				harness,
				message =>
					message.type === "display" && message.runId === "poisoned-observed" && message.output.type === "json",
			);
			const result = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "poisoned-observed",
			);
			harness.send({
				type: "run",
				runId: "poisoned-observed",
				code: "display(globalThis.__omp_poisoned_observations)",
				filename: "[poisoned-observed].js",
				snapshot,
			});
			expect(await result).toMatchObject({ type: "result", runId: "poisoned-observed", ok: true });
			const output = await observed;
			if (output.type !== "display" || output.output.type !== "json")
				throw new Error("missing poisoned observations");
			const observations = output.output.data;
			expect(Array.isArray(observations)).toBe(true);
			expect((observations as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
			expect(
				(observations as Array<Record<string, unknown>>).every(
					observation =>
						observation.processAgent === null &&
						observation.processSession === null &&
						observation.helperAgent === null &&
						observation.helperSession === null,
				),
			).toBe(true);
			expect((observations as Array<Record<string, unknown>>).map(observation => observation.label)).toEqual(
				expect.arrayContaining([
					"registry-getter",
					"registry-iterator",
					"describe-name",
					"describe-description",
					"describe-parameters",
					"dispatch-fn",
					"dispatch-callback",
					"dispatch-clone",
				]),
			);
		} finally {
			harness.send({ type: "close" });
		}
	});

	it("rejects identity-bearing inline init without changing host identity", async () => {
		process.env.RIG_AGENT_ID = "host-agent";
		process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE = "/tmp/host-parent.jsonl";
		process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID = "host-parent";
		const harness = createWorkerHarness();
		try {
			const result = waitForMessage(harness, message => message.type === "init-failed");
			harness.send({ type: "init", snapshot: { cwd: process.cwd(), sessionId: "inline", agentId: "child-agent" } });
			expect(await result).toMatchObject({ type: "init-failed", error: { name: "ToolError" } });
			expect(process.env.RIG_AGENT_ID).toBe("host-agent");
			expect(process.env.OMP_INTERNAL_PARENT_PI_SESSION_FILE).toBe("/tmp/host-parent.jsonl");
			expect(process.env.OMP_INTERNAL_PARENT_RIG_AGENT_ID).toBe("host-parent");
			expect(process.env.PI_SESSION_FILE).toBeUndefined();
		} finally {
			harness.send({ type: "close" });
		}
	});

	it("re-init while a same-realm run is live does not crash the process", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "reinit-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "reinit-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-reinit",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[reinit-first].js",
				snapshot: { cwd, sessionId: "reinit-first", localRoots: {} },
			});
			await entered.promise;

			// Re-init the second core while the first still owns the realm. Production
			// inline workers deliver this on a microtask; a setCwd throw here used to
			// become a process-fatal unhandledRejection / uncaughtException.
			const reinit = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "reinit-second", localRoots: {} } });
			const reply = await reinit;
			expect(reply.type).toBe("ready");

			// Concurrent run still fails at the exclusive run boundary, via protocol.
			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-after-reinit",
			);
			second.send({
				type: "run",
				runId: "overlap-after-reinit",
				code: "1 + 1;",
				filename: "[reinit-second].js",
				snapshot: { cwd, sessionId: "reinit-second", localRoots: {} },
			});
			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-after-reinit",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			// Drain microtasks so a latent fatal would surface.
			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("concurrent inits under a live same-realm run stay process-safe", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const third = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "init-live-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "init-live-second", localRoots: {} });
		await initializeWorker(third, { cwd, sessionId: "init-live-third", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-multi-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[init-live-first].js",
				snapshot: { cwd, sessionId: "init-live-first", localRoots: {} },
			});
			await entered.promise;

			const readySecond = waitForMessage(
				second,
				message => message.type === "ready" || message.type === "init-failed",
			);
			const readyThird = waitForMessage(
				third,
				message => message.type === "ready" || message.type === "init-failed",
			);
			second.send({ type: "init", snapshot: { cwd, sessionId: "init-live-second", localRoots: {} } });
			third.send({ type: "init", snapshot: { cwd, sessionId: "init-live-third", localRoots: {} } });
			expect((await readySecond).type).toBe("ready");
			expect((await readyThird).type).toBe("ready");

			const resultSecond = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second",
			);
			const resultThird = waitForMessage(
				third,
				message => message.type === "result" && message.runId === "overlap-third",
			);
			second.send({
				type: "run",
				runId: "overlap-second",
				code: "2",
				filename: "[init-live-second].js",
				snapshot: { cwd, sessionId: "init-live-second", localRoots: {} },
			});
			third.send({
				type: "run",
				runId: "overlap-third",
				code: "3",
				filename: "[init-live-third].js",
				snapshot: { cwd, sessionId: "init-live-third", localRoots: {} },
			});
			expect(await resultSecond).toMatchObject({
				type: "result",
				runId: "overlap-second",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
			expect(await resultThird).toMatchObject({
				type: "result",
				runId: "overlap-third",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
			third.send({ type: "close" });
		}
	});

	it("first init while a same-realm run is live fails via init-failed and recovers", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness(); // never initialized: no runtime exists yet
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "first-init-live-first", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			const firstText = waitForMessage(
				first,
				message => message.type === "text" && message.runId === "hold-for-first-init",
			);
			const firstResult = waitForMessage(
				first,
				message => message.type === "result" && message.runId === "hold-for-first-init",
			);
			first.send({
				type: "run",
				runId: "hold-for-first-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait; __omp_session__.sessionId;",
				filename: "[first-init-live-first].js",
				snapshot: { cwd, sessionId: "first-init-live-first", localRoots: {} },
			});
			await entered.promise;

			// A fresh runtime's install would Object.assign over the live runtime's
			// globals mid-run; it must fail via the protocol instead.
			const reply = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "first-init-live-second", localRoots: {} } });
			expect(await reply).toMatchObject({
				type: "init-failed",
				error: { message: "Cannot initialize a JS runtime while another same-realm JS runtime is running" },
			});

			// The held run's globals were not clobbered: it still resolves its own
			// session bag and completes cleanly.
			gate.resolve();
			expect(await firstText).toMatchObject({
				type: "text",
				runId: "hold-for-first-init",
				chunk: "first-init-live-first\n",
			});
			expect(await firstResult).toMatchObject({ type: "result", runId: "hold-for-first-init", ok: true });

			// Once the realm is free, the same core initializes cleanly.
			await initializeWorker(second, { cwd, sessionId: "first-init-live-second", localRoots: {} });

			// Drain the microtask queue so any latent fatal would surface.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("keeps the process cwd while another cell is mid-run", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-b-"));
		const chdirs: string[] = [];
		const hostListeners = new Set<(message: WorkerOutbound) => void>();
		const workerListeners = new Set<(message: WorkerInbound) => void>();
		const transport: Transport = {
			send: message => {
				queueMicrotask(() => {
					for (const listener of hostListeners) listener(message);
				});
			},
			onMessage: handler => {
				workerListeners.add(handler);
				return () => workerListeners.delete(handler);
			},
			close: () => {},
		};
		new WorkerCore(transport, { mode: "isolated", chdir: cwd => chdirs.push(cwd) });
		const harness: WorkerHarness = {
			send(message) {
				queueMicrotask(() => {
					for (const listener of workerListeners) listener(message);
				});
			},
			onMessage(handler) {
				hostListeners.add(handler);
				return () => hostListeners.delete(handler);
			},
		};

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_cwd_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		try {
			await initializeWorker(harness, { cwd: dirA, sessionId: "cwd-race", localRoots: {} });
			expect(chdirs).toEqual([dirA]);

			const holdResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-hold",
			);
			harness.send({
				type: "run",
				runId: "cwd-hold",
				code: "globalThis.__omp_worker_cwd_gate.entered(); await globalThis.__omp_worker_cwd_gate.wait;",
				filename: "[cwd-race-hold].js",
				snapshot: { cwd: dirA, sessionId: "cwd-race", localRoots: {} },
			});
			await entered.promise;

			// A second cell with a different cwd while the first is suspended must
			// not move the realm-wide process cwd out from under the live cell.
			const skipLog = waitForMessage(
				harness,
				message => message.type === "log" && message.msg.includes("kept its process cwd"),
			);
			const overlapResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-overlap",
			);
			harness.send({
				type: "run",
				runId: "cwd-overlap",
				code: "1 + 1;",
				filename: "[cwd-race-overlap].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await overlapResult).toMatchObject({ type: "result", runId: "cwd-overlap", ok: true });
			expect(chdirs).not.toContain(dirB);
			await skipLog;

			gate.resolve();
			expect(await holdResult).toMatchObject({ type: "result", runId: "cwd-hold", ok: true });

			// With the realm quiet again, the next cell lands the deferred move.
			const soloResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-solo",
			);
			harness.send({
				type: "run",
				runId: "cwd-solo",
				code: "2 + 2;",
				filename: "[cwd-race-solo].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await soloResult).toMatchObject({ type: "result", runId: "cwd-solo", ok: true });
			expect(chdirs.at(-1)).toBe(dirB);
		} finally {
			gate.resolve();
			delete (globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_cwd_gate;
			harness.send({ type: "close" });
			await fs.rm(dirA, { recursive: true, force: true });
			await fs.rm(dirB, { recursive: true, force: true });
		}
	});

	it("survives concurrent same-realm setCwd in a child process with postmortem loaded", async () => {
		// Process-level oracle: the production crash was postmortem killing the process
		// after an unhandled rejection from concurrent inline setCwd. This must stay green
		// even when postmortem's fatal handlers are installed.
		const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../../../utils/src/postmortem.ts")).href;
		const runtimeUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/eval/js/shared/runtime.ts")).href;

		const probe = `import { pathToFileURL } from "node:url";

await import(${JSON.stringify(postmortemUrl)});
const { JsRuntime } = await import(${JSON.stringify(runtimeUrl)});

const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-first" });
const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-second" });
const gate = Promise.withResolvers();
const entered = Promise.withResolvers();

const hooks = {
	onText() {},
	onDisplay() {},
	callTool: async () => undefined,
};

second.setRunScope({ gate: gate.promise, entered: () => entered.resolve() });
const hold = second.run("entered(); await gate;", "[child-second].js", hooks);
await entered.promise;

// Historical crash path: concurrent setCwd while another same-realm runtime is live.
first.setCwd(process.cwd() + "/child-pending");
second.setCwd(process.cwd());

// Microtask delivery must not become process-fatal either.
queueMicrotask(() => {
	first.setCwd(process.cwd() + "/child-pending-2");
});
await Promise.resolve();
await Bun.sleep(0);

gate.resolve();
await hold;
first.dispose();
second.dispose();
console.log("survived concurrent setCwd");
process.exit(0);
`;

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-same-realm-"));
		const probePath = path.join(root, "probe.ts");
		try {
			await Bun.write(probePath, probe);
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
			// Real process liveness cannot use fake timers. Bound a wedged child, but
			// clear the watchdog on the normal path so it never becomes a fixed wait.
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 5000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("survived concurrent setCwd");
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(stderr).not.toContain("[Uncaught Exception]");
				expect(stderr).not.toContain("another same-realm JS runtime is running");
			} finally {
				clearTimeout(watchdog);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
