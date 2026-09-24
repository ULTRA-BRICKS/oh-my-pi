import { describe, expect, it, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { nativeLibraryPathOverlay, workerEnvFromParent } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { tinyWorkerEnvOverlay } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { tinyWorkerEndpoint, tinyWorkerLogPath } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

describe("workerEnvFromParent", () => {
	it("drops inherited git repo-location overrides but keeps an explicit overlay", () => {
		// Managed PTY daemons are spawned from this snapshot; inheriting the
		// agent's own GIT_DIR would make their shells target the wrong worktree
		// (issue #11082). An explicit per-command value still wins.
		const previous = process.env.GIT_DIR;
		process.env.GIT_DIR = "/primary/.git";
		try {
			const env = workerEnvFromParent({ GIT_WORK_TREE: "/secondary", OMP_WORKER_ENV_PROBE: "kept" });
			expect(env.GIT_DIR).toBeUndefined();
			expect(env.GIT_WORK_TREE).toBe("/secondary");
			expect(env.OMP_WORKER_ENV_PROBE).toBe("kept");
		} finally {
			if (previous === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = previous;
		}
	});

	it("drops an inherited/dotenv-origin trusted-identity marker but keeps an explicit overlay", () => {
		// This snapshot is the actual spawn-time env for every daemon/service/
		// worker the broker launches. A forged or leftover PI_SESSION_FILE /
		// RIG_AGENT_ID inherited from this process's own env (e.g. loaded from
		// a project .env) must not survive into the child — only a genuine
		// identity passed via the overlay may set these keys.
		const previousSessionFile = process.env.PI_SESSION_FILE;
		const previousAgentId = process.env.RIG_AGENT_ID;
		process.env.PI_SESSION_FILE = "/forged.jsonl";
		process.env.RIG_AGENT_ID = "forged";
		try {
			const dropped = workerEnvFromParent({ PATH: "/usr/bin" });
			expect(dropped.PI_SESSION_FILE).toBeUndefined();
			expect(dropped.RIG_AGENT_ID).toBeUndefined();

			const overlaid = workerEnvFromParent({ PI_SESSION_FILE: "/real/nested/Worker.jsonl", RIG_AGENT_ID: "Worker" });
			expect(overlaid.PI_SESSION_FILE).toBe("/real/nested/Worker.jsonl");
			expect(overlaid.RIG_AGENT_ID).toBe("Worker");
		} finally {
			if (previousSessionFile === undefined) delete process.env.PI_SESSION_FILE;
			else process.env.PI_SESSION_FILE = previousSessionFile;
			if (previousAgentId === undefined) delete process.env.RIG_AGENT_ID;
			else process.env.RIG_AGENT_ID = previousAgentId;
		}
	});

	it("drops an ambient/dotenv-origin OMP_CREDENTIAL_ID that this process cannot verify as launch-sourced", () => {
		// Bun autoloads a project `.env` into `Bun.env` before any of this
		// runs, so a repo-local `.env` value is indistinguishable from a
		// genuine one in the raw snapshot. Forwarding it verbatim would let
		// every worker/daemon this spawns treat a laundered `.env` value as
		// launch-verified in turn, since it becomes a real env var at their
		// own exec time (defeating the `.env` trust boundary documented on
		// `isLaunchEnvValue`).
		const previous = process.env.OMP_CREDENTIAL_ID;
		process.env.OMP_CREDENTIAL_ID = "7";
		try {
			const env = workerEnvFromParent({ PATH: "/usr/bin" });
			expect(env.OMP_CREDENTIAL_ID).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.OMP_CREDENTIAL_ID;
			else process.env.OMP_CREDENTIAL_ID = previous;
		}
	});

	it("keeps OMP_CREDENTIAL_ID when this process itself verifies it as launch-sourced", () => {
		const previous = process.env.OMP_CREDENTIAL_ID;
		process.env.OMP_CREDENTIAL_ID = "7";
		const spy = vi.spyOn(piUtils, "isLaunchEnvValue").mockImplementation((name, value) => {
			return name === "OMP_CREDENTIAL_ID" && value === "7";
		});
		try {
			const env = workerEnvFromParent({ PATH: "/usr/bin" });
			expect(env.OMP_CREDENTIAL_ID).toBe("7");
		} finally {
			spy.mockRestore();
			if (previous === undefined) delete process.env.OMP_CREDENTIAL_ID;
			else process.env.OMP_CREDENTIAL_ID = previous;
		}
	});
});

describe("tinyWorkerEnvOverlay", () => {
	it("maps non-default settings onto the worker env vars when neither is already set", () => {
		expect(tinyWorkerEnvOverlay({}, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "fp16",
		});
	});

	it("lets a present env var win over the persisted setting", () => {
		expect(tinyWorkerEnvOverlay({ PI_TINY_DEVICE: "cpu" }, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cpu",
			PI_TINY_DTYPE: "fp16",
		});
		expect(tinyWorkerEnvOverlay({ PI_TINY_DTYPE: "q8" }, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "q8",
		});
	});

	it("omits a var when its setting is the default sentinel or unset", () => {
		expect(tinyWorkerEnvOverlay({}, "default", "default")).toEqual({});
		expect(tinyWorkerEnvOverlay({}, undefined, undefined)).toEqual({});
	});
});

describe("nativeLibraryPathOverlay", () => {
	it("appends the advertised dirs after an inherited LD_LIBRARY_PATH", () => {
		expect(
			nativeLibraryPathOverlay(
				{ LD_LIBRARY_PATH: "/inherited", OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib" },
				"linux",
			),
		).toEqual({ LD_LIBRARY_PATH: "/inherited:/store/gcc/lib" });
	});

	it("uses the advertised dirs alone when nothing is inherited", () => {
		expect(
			nativeLibraryPathOverlay({ OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib:/store/libgcc/lib" }, "linux"),
		).toEqual({ LD_LIBRARY_PATH: "/store/gcc/lib:/store/libgcc/lib" });
	});

	it("stays out of the env on non-Linux platforms", () => {
		const env = { OMP_NATIVE_LIBRARY_PATH: "/store/gcc/lib" };
		expect(nativeLibraryPathOverlay(env, "darwin")).toEqual({});
		expect(nativeLibraryPathOverlay(env, "win32")).toEqual({});
	});

	it("stays out of the env on Linux when no dirs are advertised", () => {
		expect(nativeLibraryPathOverlay({ LD_LIBRARY_PATH: "/inherited" }, "linux")).toEqual({});
		expect(nativeLibraryPathOverlay({ OMP_NATIVE_LIBRARY_PATH: "" }, "linux")).toEqual({});
	});
});

describe("tinyWorkerLogPath", () => {
	// Regression: the log used to be `${endpoint}.log`, which on Windows turns
	// the named-pipe endpoint (`\\.\pipe\omp-tiny-…`) into an unopenable file
	// path and crashed `--smoke-test` with ENOENT.
	it("stays under the runtime directory instead of deriving from the endpoint", () => {
		const runtimeDir = "/runtime";
		const logPath = tinyWorkerLogPath(runtimeDir, "lfm2.5-230m", "onnx");
		// `path.join` is platform-native, so assert containment through
		// `path.relative` rather than assuming the host's separator: on Windows
		// the same call yields `\runtime\<name>.log`.
		const relativeToRuntime = path.relative(runtimeDir, logPath);
		expect(path.isAbsolute(relativeToRuntime)).toBe(false);
		expect(relativeToRuntime.startsWith("..")).toBe(false);
		expect(logPath.endsWith(".log")).toBe(true);
		expect(logPath.includes(".sock")).toBe(false);
		if (process.platform === "win32") {
			expect(tinyWorkerEndpoint("/runtime", "lfm2.5-230m", "onnx").startsWith("\\\\.\\pipe\\")).toBe(true);
			expect(logPath.startsWith("\\\\.\\pipe\\")).toBe(false);
		}
	});
});
