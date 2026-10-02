/** Detached baselines must survive explicit worker identities without trusting caller overlays. */
import { describe, expect, it } from "bun:test";
import {
	buildHookIdentityWorkerEnv,
	detachedParentHookIdentity,
	mergeHookIdentityEnv,
	resolveHookIdentity,
	syncHookIdentityEnv,
} from "../../src/hook-identity-env";

describe("JS worker identity environment", () => {
	it("omits reserved Main hook markers while preserving real child identity", () => {
		const overlay = { RIG_AGENT_ID: "stale", PI_SESSION_FILE: "/tmp/stale.jsonl", CUSTOM: "kept" };
		const main = { agentId: " Main ", sessionFile: "/tmp/Main.jsonl" };
		expect(mergeHookIdentityEnv(overlay, main)).toEqual({ CUSTOM: "kept" });
		expect(buildHookIdentityWorkerEnv(overlay, main)).toEqual({ CUSTOM: "kept" });
		const child = { agentId: "child", sessionFile: "/tmp/child.jsonl" };
		expect(mergeHookIdentityEnv(overlay, child)).toEqual({
			RIG_AGENT_ID: "child",
			PI_SESSION_FILE: "/tmp/child.jsonl",
			CUSTOM: "kept",
		});
		expect(resolveHookIdentity(main, child)).toEqual({});
	});

	it("restores the detached launch identity after an explicit snapshot is removed", () => {
		const workerEnv = buildHookIdentityWorkerEnv(
			{
				RIG_DETACHED_AGENT: "1",
				RIG_AGENT_ID: "parent",
				PI_SESSION_FILE: "/tmp/parent.jsonl",
			},
			{ agentId: "child", sessionFile: "/tmp/child.jsonl" },
		);
		expect(workerEnv.RIG_AGENT_ID).toBe("child");
		expect(workerEnv.PI_SESSION_FILE).toBe("/tmp/child.jsonl");
		syncHookIdentityEnv(workerEnv, resolveHookIdentity(undefined, detachedParentHookIdentity(workerEnv)));
		expect(workerEnv.RIG_AGENT_ID).toBe("parent");
		expect(workerEnv.PI_SESSION_FILE).toBe("/tmp/parent.jsonl");
	});

	it("does not promote an explicit identity into an empty detached baseline", () => {
		const workerEnv = buildHookIdentityWorkerEnv(
			{ RIG_DETACHED_AGENT: "1" },
			{
				agentId: "child",
				sessionFile: "/tmp/child.jsonl",
			},
		);
		syncHookIdentityEnv(workerEnv, resolveHookIdentity(undefined, detachedParentHookIdentity(workerEnv)));
		expect(workerEnv).not.toHaveProperty("RIG_AGENT_ID");
		expect(workerEnv).not.toHaveProperty("PI_SESSION_FILE");
	});

	it("clears untrusted inherited markers without changing the host environment object", () => {
		const host = { RIG_AGENT_ID: "stale", PI_SESSION_FILE: "/tmp/stale.jsonl", PATH: "/bin" };
		expect(buildHookIdentityWorkerEnv(host, undefined)).toEqual({ PATH: "/bin" });
		expect(host.RIG_AGENT_ID).toBe("stale");
		expect(host.PI_SESSION_FILE).toBe("/tmp/stale.jsonl");
	});

	it("removes caller identity overlays for absent fields and overwrites supplied fields", () => {
		const overlay = { RIG_AGENT_ID: "forged", PI_SESSION_FILE: "/tmp/forged.jsonl", CUSTOM: "kept" };
		expect(mergeHookIdentityEnv(overlay, { agentId: "trusted" })).toEqual({
			RIG_AGENT_ID: "trusted",
			CUSTOM: "kept",
		});
		expect(mergeHookIdentityEnv(overlay, {})).toEqual({ CUSTOM: "kept" });
	});
});
