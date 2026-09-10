import { describe, expect, it } from "bun:test";
import { buildHookIdentityEnv, mergeHookIdentityEnv } from "../src/hook-identity-env";

describe("hook-identity-env", () => {
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
			mergeHookIdentityEnv({ RIG_AGENT_ID: "forged" }, {
				sessionFile: "/tmp/nested/Worker.jsonl",
				agentId: "Worker",
			}),
		).toEqual({
			RIG_AGENT_ID: "Worker",
			PI_SESSION_FILE: "/tmp/nested/Worker.jsonl",
		});
	});
});
