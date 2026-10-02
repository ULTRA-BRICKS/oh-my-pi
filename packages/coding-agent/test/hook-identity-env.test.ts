import { describe, expect, it } from "bun:test";
import { buildManagedKernelEnv, buildManagedKernelEnvPatch } from "../src/eval/executor-base";
import {
	buildHookIdentityEnv,
	detachedParentHookIdentity,
	filterStringEnvironment,
	getHookInvocationEnv,
	mergeHookIdentityEnv,
	resolveHookIdentity,
	withHookIdentity,
} from "../src/hook-identity-env";
import { MAIN_AGENT_ID } from "../src/registry/agent-registry";

it("clears Main identity from retained kernel patches and preserves child identity", () => {
	const main = { agentId: "Main", sessionFile: "/tmp/Main.jsonl" };
	expect(buildManagedKernelEnvPatch(main)).toMatchObject({ RIG_AGENT_ID: null, PI_SESSION_FILE: null });
	expect(buildManagedKernelEnvPatch(main, { sparse: true })).toEqual({});
	expect(buildManagedKernelEnvPatch({ agentId: "child", sessionFile: "/tmp/child.jsonl" })).toMatchObject({
		RIG_AGENT_ID: "child",
		PI_SESSION_FILE: "/tmp/child.jsonl",
	});
});

it("filters non-string environment slots before hook subprocess spawn", () => {
	const filtered = filterStringEnvironment({
		OMP_TEST_STRING_ENV_SLOT: "present",
		OMP_TEST_UNDEFINED_ENV_SLOT: undefined,
		OMP_TEST_NULL_ENV_SLOT: null,
	});
	expect(filtered).toEqual({ OMP_TEST_STRING_ENV_SLOT: "present" });
});

it("merges current scoped identity into hook invocation env", () => {
	const invocation = withHookIdentity({ sessionFile: "/tmp/child.jsonl", agentId: "child" }, () =>
		getHookInvocationEnv(),
	);
	expect(invocation).toMatchObject({ PI_SESSION_FILE: "/tmp/child.jsonl", RIG_AGENT_ID: "child" });
});

describe("hook-identity-env", () => {
	it("does not combine an explicit session file with an inherited agent id", () => {
		expect(
			resolveHookIdentity(
				{ sessionFile: "/tmp/explicit.jsonl" },
				{ sessionFile: "/tmp/inherited.jsonl", agentId: "inherited-agent" },
			),
		).toEqual({});
	});

	it("explicit Main clears detached parent identity", () => {
		const inherited = detachedParentHookIdentity({
			RIG_DETACHED_AGENT: "1",
			PI_SESSION_FILE: "/tmp/parent/DetachedChild.jsonl",
			RIG_AGENT_ID: "DetachedChild",
		});
		expect(resolveHookIdentity({ agentId: MAIN_AGENT_ID }, inherited)).toEqual({});
		expect(resolveHookIdentity({ agentId: ` ${MAIN_AGENT_ID} `, sessionFile: "/tmp/Main.jsonl" }, inherited)).toEqual(
			{},
		);
	});

	it("builds PI_SESSION_FILE and RIG_AGENT_ID for nested subagent transcripts", () => {
		const nested =
			"/tmp/omp-sessions/-xp-rig-cli/2026-09-07T21-17-48-938Z_01a07dbc-040a-7089-9724-7f37bfdba15e/ThinNotSub.jsonl";
		expect(buildHookIdentityEnv({ sessionFile: nested, agentId: "ThinNotSub" })).toEqual({
			PI_SESSION_FILE: nested,
			RIG_AGENT_ID: "ThinNotSub",
		});
	});

	it("omits blank identity markers", () => {
		expect(buildHookIdentityEnv({ sessionFile: "  ", agentId: "" })).toEqual({});
	});

	it("mergeHookIdentityEnv lets identity override caller overlays", () => {
		expect(
			mergeHookIdentityEnv(
				{ RIG_AGENT_ID: "forged" },
				{
					sessionFile: "/tmp/nested/Worker.jsonl",
					agentId: "Worker",
				},
			),
		).toEqual({
			RIG_AGENT_ID: "Worker",
			PI_SESSION_FILE: "/tmp/nested/Worker.jsonl",
		});
	});
	it("buildManagedKernelEnv exports hook identity markers to eval kernels", () => {
		const nested = "/tmp/omp-sessions/parent/Worker.jsonl";
		expect(buildManagedKernelEnv({ sessionFile: nested, agentId: "Worker" })).toEqual({
			PI_SESSION_FILE: nested,
			RIG_AGENT_ID: "Worker",
		});
	});
	it("buildManagedKernelEnvPatch clears RIG_AGENT_ID on null agentId", () => {
		expect(buildManagedKernelEnvPatch({ agentId: "Worker" }).RIG_AGENT_ID).toBe("Worker");
		expect(buildManagedKernelEnvPatch({ agentId: undefined }).RIG_AGENT_ID).toBeNull();
		expect(buildManagedKernelEnvPatch({ agentId: undefined }, { sparse: true })).not.toHaveProperty("RIG_AGENT_ID");
	});
});
