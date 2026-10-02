/** Worker fallback must preserve child identity without mutating the host realm. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { postmortem, ptree } from "@oh-my-pi/pi-utils";
import {
	disposeAllVmContexts,
	executeInVmContext,
	invokeJsTool,
	setJsEvalWorkerThreadForTests,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as workerClient from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

interface QueuedWorkerTransport {
	transport: Transport;
	send(message: WorkerInbound): void;
	waitFor(predicate: (message: WorkerOutbound) => boolean): Promise<WorkerOutbound>;
}

function createQueuedWorkerTransport(): QueuedWorkerTransport {
	const outbound: WorkerOutbound[] = [];
	const waiters: Array<{
		predicate: (message: WorkerOutbound) => boolean;
		resolve: (message: WorkerOutbound) => void;
	}> = [];
	let workerHandler: ((message: WorkerInbound) => void) | undefined;
	const inbound: WorkerInbound[] = [];
	let inboundQueued = false;

	const dispatchOutbound = (): void => {
		for (let waiterIndex = waiters.length - 1; waiterIndex >= 0; waiterIndex--) {
			const waiter = waiters[waiterIndex];
			if (!waiter) continue;
			const messageIndex = outbound.findIndex(waiter.predicate);
			if (messageIndex < 0) continue;
			const message = outbound.splice(messageIndex, 1)[0];
			waiters.splice(waiterIndex, 1);
			if (message) waiter.resolve(message);
		}
	};
	const dispatchInbound = (): void => {
		inboundQueued = false;
		if (!workerHandler) return;
		while (inbound.length > 0) {
			const message = inbound.shift();
			if (message) workerHandler(message);
		}
	};

	return {
		transport: {
			send(message) {
				outbound.push(message);
				queueMicrotask(dispatchOutbound);
			},
			onMessage(handler) {
				workerHandler = handler;
				return () => {
					if (workerHandler === handler) workerHandler = undefined;
				};
			},
			close() {},
		},
		send(message) {
			inbound.push(message);
			if (inboundQueued) return;
			inboundQueued = true;
			queueMicrotask(dispatchInbound);
		},
		waitFor(predicate) {
			const messageIndex = outbound.findIndex(predicate);
			if (messageIndex >= 0) {
				const message = outbound.splice(messageIndex, 1)[0];
				if (message) return Promise.resolve(message);
			}
			const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
			waiters.push({ predicate, resolve });
			return promise;
		},
	};
}
interface IdentityValues {
	agent: string | null;
	session: string | null;
}

interface IdentityObservation {
	process: IdentityValues;
	helper: IdentityValues;
	child: IdentityValues;
}

function isIdentityValues(value: unknown): value is IdentityValues {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const agent = Reflect.get(value, "agent");
	const session = Reflect.get(value, "session");
	return (typeof agent === "string" || agent === null) && (typeof session === "string" || session === null);
}

function isIdentityObservation(value: unknown): value is IdentityObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		isIdentityValues(Reflect.get(value, "process")) &&
		isIdentityValues(Reflect.get(value, "helper")) &&
		isIdentityValues(Reflect.get(value, "child"))
	);
}

function makeSession(): ToolSession {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
	return session;
}

async function readIdentity(options: {
	sessionKey: string;
	sessionFile?: string;
	agentId?: string;
}): Promise<IdentityObservation> {
	let observation: unknown;
	await executeInVmContext({
		sessionKey: options.sessionKey,
		sessionId: options.sessionKey,
		cwd: process.cwd(),
		session: makeSession(),
		sessionFile: options.sessionFile,
		agentId: options.agentId,
		code: `
			const child = Bun.spawn([process.execPath, "-e",
				'process.stdout.write(JSON.stringify({ agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null }))',
			], { stdout: "pipe", env: process.env });
			const childText = await new Response(child.stdout).text();
			await child.exited;
			display({
				process: { agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null },
				helper: { agent: env("RIG_AGENT_ID") ?? null, session: env("PI_SESSION_FILE") ?? null },
				child: JSON.parse(childText),
			});
		`,
		filename: `${options.sessionKey}.js`,
		runState: {
			onDisplay: output => {
				if (output.type === "json") observation = output.data;
			},
		},
	});
	if (!isIdentityObservation(observation)) throw new Error("identity probe returned an invalid observation");
	return observation;
}

describe("JS eval worker hook identity", () => {
	let inheritedEnv: NodeJS.ProcessEnv;
	beforeEach(() => {
		inheritedEnv = { ...process.env };
		for (const key of [
			"PI_SESSION_FILE",
			"RIG_AGENT_ID",
			"RIG_DETACHED_AGENT",
			"OMP_INTERNAL_PARENT_PI_SESSION_FILE",
			"OMP_INTERNAL_PARENT_RIG_AGENT_ID",
		] as const)
			delete process.env[key];
	});
	afterEach(async () => {
		await disposeAllVmContexts();
		vi.restoreAllMocks();
		for (const key of [
			"PI_SESSION_FILE",
			"RIG_AGENT_ID",
			"RIG_DETACHED_AGENT",
			"OMP_INTERNAL_PARENT_PI_SESSION_FILE",
			"OMP_INTERNAL_PARENT_RIG_AGENT_ID",
		] as const) {
			const value = inheritedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("refreshes raw process, helper, and child-visible identity for A → B → absent on one session key", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(true);
		try {
			const first = await readIdentity({
				sessionKey: "same-session-key",
				sessionFile: "/tmp/identity-a.jsonl",
				agentId: "identity-a",
			});
			const second = await readIdentity({
				sessionKey: "same-session-key",
				sessionFile: "/tmp/identity-b.jsonl",
				agentId: "identity-b",
			});
			const absent = await readIdentity({ sessionKey: "same-session-key" });
			expect(first).toEqual({
				process: { agent: "identity-a", session: "/tmp/identity-a.jsonl" },
				helper: { agent: "identity-a", session: "/tmp/identity-a.jsonl" },
				child: { agent: "identity-a", session: "/tmp/identity-a.jsonl" },
			});
			expect(second).toEqual({
				process: { agent: "identity-b", session: "/tmp/identity-b.jsonl" },
				helper: { agent: "identity-b", session: "/tmp/identity-b.jsonl" },
				child: { agent: "identity-b", session: "/tmp/identity-b.jsonl" },
			});
			expect(absent).toEqual({
				process: { agent: null, session: null },
				helper: { agent: null, session: null },
				child: { agent: null, session: null },
			});
		} finally {
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("preserves detached inherited identity only when the snapshot is absent", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(true);
		process.env.RIG_AGENT_ID = "detached-parent";
		process.env.PI_SESSION_FILE = "/tmp/detached-parent.jsonl";
		process.env.RIG_DETACHED_AGENT = "1";
		try {
			await readIdentity({
				sessionKey: "detached-inheritance",
				agentId: "explicit-child",
				sessionFile: "/tmp/child.jsonl",
			});
			const inherited = await readIdentity({ sessionKey: "detached-inheritance" });
			expect(inherited).toEqual({
				process: { agent: "detached-parent", session: "/tmp/detached-parent.jsonl" },
				helper: { agent: "detached-parent", session: "/tmp/detached-parent.jsonl" },
				child: { agent: "detached-parent", session: "/tmp/detached-parent.jsonl" },
			});
		} finally {
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("strips stale inherited identity when the snapshot is absent and not detached", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(true);
		process.env.RIG_AGENT_ID = "stale-parent";
		process.env.PI_SESSION_FILE = "/tmp/stale-parent.jsonl";
		process.env.RIG_DETACHED_AGENT = "0";
		try {
			const stale = await readIdentity({ sessionKey: "stale-overlay" });
			expect(stale).toEqual({
				process: { agent: null, session: null },
				helper: { agent: null, session: null },
				child: { agent: null, session: null },
			});
		} finally {
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("fails closed for explicit identity in the inline fallback", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(true);
		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		if (!originalWorkerDescriptor) throw new Error("Worker property descriptor is unavailable");
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			value: class {
				constructor() {
					throw new Error("forced Bun Worker construction failure");
				}
			},
		});
		try {
			await expect(readIdentity({ sessionKey: "inline-child-identity", agentId: "child-agent" })).rejects.toThrow(
				"Cannot use inline JS eval worker for an identity-bearing session",
			);
			expect(process.env.RIG_AGENT_ID).toBeUndefined();
			expect(process.env.PI_SESSION_FILE).toBeUndefined();
		} finally {
			Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("runs inline tool callbacks under identity-clearing scope after process and Worker failures", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(false);
		const spawn = vi.spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
			throw new Error("forced subprocess construction failure");
		});
		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		if (!originalWorkerDescriptor) throw new Error("Worker property descriptor is unavailable");
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			value: class {
				constructor() {
					throw new Error("forced Bun Worker construction failure");
				}
			},
		});
		process.env.RIG_DETACHED_AGENT = "1";
		process.env.RIG_AGENT_ID = "detached-parent";
		process.env.PI_SESSION_FILE = "/tmp/detached-parent.jsonl";
		const sessionKey = "inline-tool-detached-parent";
		try {
			await executeInVmContext({
				sessionKey,
				sessionId: sessionKey,
				cwd: process.cwd(),
				session: makeSession(),
				sessionFile: "/tmp/main.jsonl",
				agentId: "Main",
				code: `
					tool(async () => {
						const child = Bun.spawn([process.execPath, "-e",
							'process.stdout.write(JSON.stringify({ agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null }))',
						], { stdout: "pipe", env: process.env });
						const childText = await new Response(child.stdout).text();
						await child.exited;
						return {
							process: { agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null },
							child: JSON.parse(childText),
						};
					}, {
						name: "identity_probe",
						description: "Read hook identity markers",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					});
				`,
				filename: `${sessionKey}.js`,
				runState: {},
			});
			const called = await invokeJsTool(
				{ op: "call", name: "identity_probe", args: {} },
				{ sessionKey, session: makeSession() },
			);
			expect(called).toEqual({
				ok: true,
				value: {
					process: { agent: null, session: null },
					child: { agent: null, session: null },
				},
			});
		} finally {
			Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			spawn.mockRestore();
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("clears stale identity markers in identity-free inline execution when detached detection is invalid", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(false);
		const spawn = vi.spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
			throw new Error("forced subprocess construction failure");
		});
		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		if (!originalWorkerDescriptor) throw new Error("Worker property descriptor is unavailable");
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			value: class {
				constructor() {
					throw new Error("forced Bun Worker construction failure");
				}
			},
		});
		process.env.RIG_DETACHED_AGENT = "0";
		process.env.RIG_AGENT_ID = "stale-parent";
		process.env.PI_SESSION_FILE = "/tmp/stale-parent.jsonl";
		try {
			const stale = await readIdentity({ sessionKey: "inline-stale-parent" });
			expect(stale).toEqual({
				process: { agent: null, session: null },
				helper: { agent: null, session: null },
				child: { agent: null, session: null },
			});
		} finally {
			Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			spawn.mockRestore();
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("suppresses detached parent identity in the Main inline fallback after both isolated rungs fail", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(false);
		const spawn = vi.spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
			throw new Error("forced subprocess construction failure");
		});
		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		if (!originalWorkerDescriptor) throw new Error("Worker property descriptor is unavailable");
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			value: class {
				constructor() {
					throw new Error("forced Bun Worker construction failure");
				}
			},
		});
		const parent = {
			agent: "detached-parent",
			session: "/tmp/detached-parent.jsonl",
		};
		process.env.RIG_DETACHED_AGENT = "1";
		process.env.RIG_AGENT_ID = parent.agent;
		process.env.PI_SESSION_FILE = parent.session;
		try {
			const observation = await readIdentity({
				sessionKey: "inline-main-detached-parent",
				sessionFile: "/tmp/main.jsonl",
				agentId: "Main",
			});
			expect(observation).toEqual({
				process: { agent: null, session: null },
				helper: { agent: null, session: null },
				child: { agent: null, session: null },
			});
		} finally {
			Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			spawn.mockRestore();
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});

	it("preserves identity when subprocess construction falls back to a Bun Worker", async () => {
		const previousWorkerThreadMode = setJsEvalWorkerThreadForTests(false);
		const spawn = vi.spyOn(workerClient, "createWorkerSubprocess").mockImplementation(() => {
			throw new Error("forced subprocess construction failure");
		});
		try {
			const observation = await readIdentity({ sessionKey: "process-fallback", agentId: "fallback-agent" });
			expect(spawn).toHaveBeenCalled();
			expect(observation).toEqual({
				process: { agent: "fallback-agent", session: null },
				helper: { agent: "fallback-agent", session: null },
				child: { agent: "fallback-agent", session: null },
			});
		} finally {
			setJsEvalWorkerThreadForTests(previousWorkerThreadMode);
		}
	});
	it("keeps identity-free inline markers cleared across overlapping run and tool scopes", async () => {
		const queued = createQueuedWorkerTransport();
		const core = new WorkerCore(queued.transport, {
			mode: "inline",
			interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
		});
		const globals = globalThis as typeof globalThis & {
			__ompIdentityOverlapOuterGate?: Promise<void>;
			__ompIdentityOverlapCallbackRelease?: Promise<void>;
			__ompIdentityOverlapResolveOuterGate?: () => void;
		};
		const outerGate = Promise.withResolvers<void>();
		const callbackRelease = Promise.withResolvers<void>();
		globals.__ompIdentityOverlapOuterGate = outerGate.promise;
		globals.__ompIdentityOverlapCallbackRelease = callbackRelease.promise;
		globals.__ompIdentityOverlapResolveOuterGate = outerGate.resolve;
		process.env.RIG_DETACHED_AGENT = "0";
		process.env.RIG_AGENT_ID = "stale-inline-parent";
		process.env.PI_SESSION_FILE = "   ";
		const cwd = process.cwd();
		const snapshot: SessionSnapshot = {
			cwd,
			sessionId: "identity-overlap",
			localRoots: {},
		};
		try {
			const ready = queued.waitFor(message => message.type === "ready" || message.type === "init-failed");
			queued.send({ type: "init", snapshot });
			expect(await ready).toEqual({ type: "ready" });

			const outerResult = queued.waitFor(message => message.type === "result" && message.runId === "outer");
			const toolReady = queued.waitFor(
				message =>
					message.type === "display" &&
					message.runId === "outer" &&
					message.output.type === "json" &&
					typeof message.output.data === "object" &&
					message.output.data !== null &&
					Reflect.get(message.output.data, "stage") === "tool-ready",
			);
			queued.send({
				type: "run",
				runId: "outer",
				filename: "[identity-overlap].js",
				snapshot,
				code: `
					tool(async () => {
						display({ stage: "callback-started" });
						globalThis.__ompIdentityOverlapResolveOuterGate();
						await globalThis.__ompIdentityOverlapCallbackRelease;
						return {
							process: {
								agent: process.env.RIG_AGENT_ID ?? null,
								session: process.env.PI_SESSION_FILE ?? null,
							},
							helper: {
								agent: env("RIG_AGENT_ID") ?? null,
								session: env("PI_SESSION_FILE") ?? null,
							},
						};
					}, {
						name: "identity_overlap",
						description: "Read hook identity markers",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					});
					display({ stage: "tool-ready" });
					await globalThis.__ompIdentityOverlapOuterGate;
				`,
			});
			expect(await toolReady).toMatchObject({
				type: "display",
				runId: "outer",
				output: { type: "json", data: { stage: "tool-ready" } },
			});
			const callbackStarted = queued.waitFor(
				message =>
					message.type === "display" &&
					message.runId === "tool-overlap" &&
					message.output.type === "json" &&
					typeof message.output.data === "object" &&
					message.output.data !== null &&
					Reflect.get(message.output.data, "stage") === "callback-started",
			);
			queued.send({
				type: "tool",
				runId: "tool-overlap",
				op: "call",
				name: "identity_overlap",
				args: {},
			});
			expect(await callbackStarted).toMatchObject({
				type: "display",
				runId: "tool-overlap",
				output: { type: "json", data: { stage: "callback-started" } },
			});

			expect(await outerResult).toEqual({ type: "result", runId: "outer", ok: true });
			expect(process.env.RIG_AGENT_ID).toBeUndefined();
			expect(process.env.PI_SESSION_FILE).toBeUndefined();

			const callbackDisplay = queued.waitFor(
				message =>
					message.type === "display" &&
					message.runId === "tool-overlap" &&
					message.output.type === "json" &&
					typeof message.output.data === "object" &&
					message.output.data !== null &&
					Reflect.get(message.output.data, "ok") === true,
			);
			const callbackResult = queued.waitFor(
				message => message.type === "result" && message.runId === "tool-overlap",
			);
			callbackRelease.resolve();
			expect(await callbackDisplay).toMatchObject({
				type: "display",
				runId: "tool-overlap",
				output: {
					type: "json",
					data: {
						ok: true,
						value: {
							process: { agent: null, session: null },
							helper: { agent: null, session: null },
						},
					},
				},
			});
			expect(await callbackResult).toEqual({ type: "result", runId: "tool-overlap", ok: true });
			expect({
				agent: process.env.RIG_AGENT_ID,
				session: process.env.PI_SESSION_FILE,
				detached: process.env.RIG_DETACHED_AGENT,
			}).toEqual({
				agent: "stale-inline-parent",
				session: "   ",
				detached: "0",
			});
		} finally {
			outerGate.resolve();
			callbackRelease.resolve();
			core.dispose();
			delete globals.__ompIdentityOverlapOuterGate;
			delete globals.__ompIdentityOverlapCallbackRelease;
			delete globals.__ompIdentityOverlapResolveOuterGate;
			delete process.env.RIG_AGENT_ID;
			delete process.env.PI_SESSION_FILE;
			delete process.env.RIG_DETACHED_AGENT;
		}
	});
	it("clears identity while extracting a retained inline tool registry", async () => {
		const queued = createQueuedWorkerTransport();
		const core = new WorkerCore(queued.transport, {
			mode: "inline",
			interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
		});
		const staleAgent = "stale-inline-parent";
		const staleSession = "  /tmp/stale-inline-parent.jsonl  ";
		process.env.RIG_DETACHED_AGENT = "0";
		process.env.RIG_AGENT_ID = staleAgent;
		process.env.PI_SESSION_FILE = staleSession;
		const cwd = process.cwd();
		const snapshot: SessionSnapshot = {
			cwd,
			sessionId: "identity-retained-registry",
			localRoots: {},
		};
		try {
			const ready = queued.waitFor(message => message.type === "ready" || message.type === "init-failed");
			queued.send({ type: "init", snapshot });
			expect(await ready).toEqual({ type: "ready" });

			const setupReady = queued.waitFor(
				message =>
					message.type === "display" &&
					message.runId === "retained-registry-setup" &&
					message.output.type === "json" &&
					typeof message.output.data === "object" &&
					message.output.data !== null &&
					Reflect.get(message.output.data, "stage") === "tool-ready",
			);
			const setupResult = queued.waitFor(
				message => message.type === "result" && message.runId === "retained-registry-setup",
			);
			queued.send({
				type: "run",
				runId: "retained-registry-setup",
				filename: "[identity-retained-registry].js",
				snapshot,
				code: `
					let registryObservation;
					const observeIdentity = () => {
						const child = Bun.spawnSync([process.execPath, "-e",
							'process.stdout.write(JSON.stringify({ agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null }))',
						], { stdout: "pipe", env: process.env });
						return {
							process: { agent: process.env.RIG_AGENT_ID ?? null, session: process.env.PI_SESSION_FILE ?? null },
							helper: { agent: env("RIG_AGENT_ID") ?? null, session: env("PI_SESSION_FILE") ?? null },
							child: JSON.parse(new TextDecoder().decode(child.stdout)),
						};
					};
					tool(async () => ({
						registry: registryObservation,
						callback: observeIdentity(),
					}), {
						name: "identity_retained_registry",
						description: "Read hook identity markers",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					});
					const registry = globalThis.__omp_tools__;
					const retained = registry.get("identity_retained_registry");
					registry.clear();
					registry.set("identity_retained_registry", retained);
					Object.defineProperty(registry, Symbol.iterator, {
						configurable: true,
						get() {
							registryObservation = observeIdentity();
							return Map.prototype[Symbol.iterator];
						},
					});
					globalThis.__omp_tools__ = registry;
					display({ stage: "tool-ready" });
				`,
			});
			expect(await setupReady).toMatchObject({
				type: "display",
				runId: "retained-registry-setup",
				output: { type: "json", data: { stage: "tool-ready" } },
			});
			expect(await setupResult).toEqual({ type: "result", runId: "retained-registry-setup", ok: true });

			const dispatchDisplay = queued.waitFor(
				message =>
					message.type === "display" &&
					message.runId === "retained-registry-call" &&
					message.output.type === "json",
			);
			const dispatchResult = queued.waitFor(
				message => message.type === "result" && message.runId === "retained-registry-call",
			);
			queued.send({
				type: "tool",
				runId: "retained-registry-call",
				op: "call",
				name: "identity_retained_registry",
				args: {},
			});
			const display = await dispatchDisplay;
			if (display.type !== "display" || display.output.type !== "json")
				throw new Error("missing retained registry output");
			expect(display).toEqual({
				type: "display",
				runId: "retained-registry-call",
				output: {
					type: "json",
					data: {
						ok: true,
						value: {
							registry: {
								process: { agent: null, session: null },
								helper: { agent: null, session: null },
								child: { agent: null, session: null },
							},
							callback: {
								process: { agent: null, session: null },
								helper: { agent: null, session: null },
								child: { agent: null, session: null },
							},
						},
					},
				},
			});
			expect(await dispatchResult).toEqual({ type: "result", runId: "retained-registry-call", ok: true });
			expect({
				agent: process.env.RIG_AGENT_ID,
				session: process.env.PI_SESSION_FILE,
			}).toEqual({ agent: staleAgent, session: staleSession });
		} finally {
			core.dispose();
			delete process.env.RIG_AGENT_ID;
			delete process.env.PI_SESSION_FILE;
			delete process.env.RIG_DETACHED_AGENT;
		}
	});
});

it("resolves Main suppression before deciding inline fallback under detached parent markers", async () => {
	const result = await ptree.exec(
		[process.execPath, "test", path.resolve(import.meta.dir, "../fixtures/js-inline-identity.fixture.ts")],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				RIG_DETACHED_AGENT: "1",
				RIG_AGENT_ID: "detached-parent",
				PI_SESSION_FILE: "/tmp/detached-parent.jsonl",
				OMP_INTERNAL_PARENT_RIG_AGENT_ID: "detached-parent",
				OMP_INTERNAL_PARENT_PI_SESSION_FILE: "/tmp/detached-parent.jsonl",
			},
			timeout: 15_000,
		},
	);
	expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) });
}, 20_000);
