import { describe, expect, it } from "bun:test";
import { buildServiceSpawnEnv } from "../../src/launch/services";

describe("buildServiceSpawnEnv identity hardening", () => {
	it("strips an inherited/dotenv-origin identity from the shell base env when the caller supplies no identity", () => {
		const shellEnv = { PATH: "/usr/bin", PI_SESSION_FILE: "/forged.jsonl", RIG_AGENT_ID: "forged" };
		expect(buildServiceSpawnEnv(shellEnv, undefined)).toEqual({ PATH: "/usr/bin" });
	});

	it("honors a genuine identity supplied by the caller overlay", () => {
		const shellEnv = { PATH: "/usr/bin", PI_SESSION_FILE: "/forged.jsonl", RIG_AGENT_ID: "forged" };
		const callerEnv = { PI_SESSION_FILE: "/real/nested/Worker.jsonl", RIG_AGENT_ID: "Worker" };
		expect(buildServiceSpawnEnv(shellEnv, callerEnv)).toEqual({
			PATH: "/usr/bin",
			PI_SESSION_FILE: "/real/nested/Worker.jsonl",
			RIG_AGENT_ID: "Worker",
		});
	});

	it("leaves unrelated shell env vars untouched", () => {
		const shellEnv = { PATH: "/usr/bin", HOME: "/home/user", SHELL: "/bin/zsh" };
		expect(buildServiceSpawnEnv(shellEnv, { EXTRA: "1" })).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/user",
			SHELL: "/bin/zsh",
			EXTRA: "1",
		});
	});
});
