/**
 * Issue #12: commands a subagent's bash call starts must not outlive the omp
 * host when it dies without running any cleanup (SIGKILL, a native abort), and
 * deliberately detached work must survive. Each case runs a real host process
 * (test/fixtures/lifeline-host.ts: lifeline started as at omp startup, commands
 * through the real BashTool) and kills it from outside. Real processes and real
 * timers are the contract here: "gone within 5 seconds of the kill" is measured
 * on the wall clock across process boundaries, which fake timers cannot model.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

const HOST = path.join(import.meta.dir, "fixtures", "lifeline-host.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
/** Portable `setsid(1)`: macOS ships no setsid binary. */
const SETSID = `perl -MPOSIX -e "POSIX::setsid() or die; exec @ARGV"`;
const REAP_WINDOW_MS = 5_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		try {
			cleanup();
		} catch {}
	}
});

type Host = Subprocess<"pipe", "pipe", "inherit" | "ignore">;

function spawnHost(dir: string, env: Record<string, string>, stderr: "inherit" | "ignore" = "inherit"): Host {
	const host = Bun.spawn([process.execPath, HOST], {
		cwd: REPO_ROOT,
		env: { ...Bun.env, LIFELINE_DIR: dir, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr,
	});
	cleanups.push(() => host.kill("SIGKILL"));
	return host;
}

async function waitFor<T>(
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

async function readyLine(host: Host): Promise<void> {
	const reader = host.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	expect(new TextDecoder().decode(value)).toBe("ready\n");
}

/** Pin every pid listed in `file` (start-time identity) once `count` are there. */
async function pinned(file: string, count: number): Promise<Process[]> {
	const pids = await waitFor(
		async () => {
			const lines = (
				await Bun.file(file)
					.text()
					.catch(() => "")
			)
				.split(/\s+/)
				.filter(Boolean);
			return lines.length >= count ? lines.map(Number) : undefined;
		},
		30_000,
		`${count} pids in ${file}`,
	);
	const processes = pids.map(pid => {
		const handle = Process.fromPid(pid);
		if (!handle) throw new Error(`process ${pid} already gone`);
		return handle;
	});
	cleanups.push(() => {
		for (const handle of processes) handle.killTree();
	});
	return processes;
}

async function processGroup(pid: number): Promise<number> {
	return Number((await Bun.$`ps -o pgid= -p ${pid}`.quiet().nothrow().text()).trim());
}

function running(processes: Process[]): number[] {
	return processes.filter(handle => handle.status() === "running").map(handle => handle.pid);
}

async function survivorsAfter(processes: Process[], windowMs: number): Promise<number[]> {
	const deadline = performance.now() + windowMs;
	while (running(processes).length > 0 && performance.now() < deadline) await Bun.sleep(25);
	return running(processes);
}

/**
 * A bash-tool command that starts `sleep 600` plus a grandchild in its own
 * `setsid` session, recording `sh`, the sleep, and the grandchild in `file`.
 */
function treeCommand(file: string): string {
	return `sh -c 'echo $$ >> "$0"; sleep 600 & echo $! >> "$0"; ${SETSID} sleep 600 & echo $! >> "$0"; wait' '${file}'`;
}

async function startedTree(host: Host, file: string): Promise<Process[]> {
	await readyLine(host);
	const tree = await pinned(file, 3);
	const grandchild = tree[2].pid;
	await waitFor(async () => ((await processGroup(grandchild)) === grandchild ? true : undefined), 10_000, "setsid");
	return tree;
}

describe("process lifeline (#12)", () => {
	it("kills a subagent bash command's tree, setsid grandchild included, within 5s of the host being SIGKILLed", async () => {
		using tmp = TempDir.createSync("@omp-lifeline-kill-");
		const pids = path.join(tmp.path(), "tree.pids");
		const host = spawnHost(tmp.path(), { LIFELINE_COMMANDS: JSON.stringify([treeCommand(pids)]) });
		const tree = await startedTree(host, pids);
		expect(running(tree)).toHaveLength(3);

		host.kill("SIGKILL");

		expect(await survivorsAfter(tree, REAP_WINDOW_MS)).toEqual([]);
	}, 60_000);

	it("kills a PTY-run command that ignores the terminal hangup when the host is SIGKILLed", async () => {
		using tmp = TempDir.createSync("@omp-lifeline-pty-");
		const pids = path.join(tmp.path(), "pty.pids");
		// Ignoring SIGHUP makes the closing PTY master harmless, so only the
		// lifeline can stop this tree.
		const host = spawnHost(tmp.path(), {
			LIFELINE_PTY_COMMAND: `trap '' HUP; echo $$ >> '${pids}'; sleep 600 & echo $! >> '${pids}'; wait`,
		});
		await readyLine(host);
		const tree = await pinned(pids, 2);

		host.kill("SIGKILL");

		expect(await survivorsAfter(tree, REAP_WINDOW_MS)).toEqual([]);
	}, 60_000);

	it("kills the same tree when the host dies from abort() on a native thread", async () => {
		using tmp = TempDir.createSync("@omp-lifeline-abort-");
		const pids = path.join(tmp.path(), "tree.pids");
		// stderr ignored: Bun prints its crash banner for the deliberate abort().
		const host = spawnHost(
			tmp.path(),
			{ LIFELINE_COMMANDS: JSON.stringify([treeCommand(pids)]), LIFELINE_DEATH: "native-abort" },
			"ignore",
		);
		const tree = await startedTree(host, pids);

		host.stdin.write("go\n");
		host.stdin.flush();
		await host.exited;

		expect(host.signalCode).toBe("SIGABRT");
		expect(await survivorsAfter(tree, REAP_WINDOW_MS)).toEqual([]);
	}, 60_000);

	it("leaves `nohup cmd &` and persist launch daemons running after the host is killed", async () => {
		using tmp = TempDir.createSync("@omp-lifeline-detach-");
		const owned = path.join(tmp.path(), "owned.pid");
		const nohupped = path.join(tmp.path(), "nohup.pid");
		const daemon = path.join(tmp.path(), "daemon.pid");
		const host = spawnHost(tmp.path(), {
			LIFELINE_COMMANDS: JSON.stringify([
				`sh -c 'echo $$ > "$0"; exec sleep 600' '${owned}'`,
				`nohup sh -c 'echo $$ > "$0"; exec sleep 600' '${nohupped}' &`,
			]),
			LIFELINE_PERSIST_DAEMON: `echo $$ > '${daemon}'; exec sleep 600`,
		});
		await readyLine(host);
		const [control] = await pinned(owned, 1);
		const detached = [...(await pinned(nohupped, 1)), ...(await pinned(daemon, 1))];

		host.kill("SIGKILL");

		// The owned command dying proves the reaper ran; the detached ones must not.
		expect(await survivorsAfter([control], REAP_WINDOW_MS)).toEqual([]);
		expect(running(detached)).toEqual(detached.map(handle => handle.pid));
	}, 90_000);

	it("reaps a dead host's commands at the next start when its supervisor died too, and reports the count", async () => {
		using tmp = TempDir.createSync("@omp-lifeline-sweep-");
		const pids = path.join(tmp.path(), "tree.pids");
		const host = spawnHost(tmp.path(), { LIFELINE_COMMANDS: JSON.stringify([treeCommand(pids)]) });
		const tree = await startedTree(host, pids);
		// The supervisor is the only process whose argv carries the reaper selector
		// with this test's record directory.
		const table = await Bun.$`ps -axo pid=,args=`.quiet().text();
		const supervisors = table
			.split("\n")
			.filter(line => line.includes("__omp_worker_lifeline_reap") && line.includes(tmp.path()))
			.map(line => Number.parseInt(line.trim(), 10));
		expect(supervisors).toHaveLength(1);

		process.kill(supervisors[0], "SIGKILL");
		host.kill("SIGKILL");
		await host.exited;
		// Absence of a reaper can only be observed by waiting: give one the time
		// the first case shows it needs, then confirm the tree is still up.
		await Bun.sleep(1_000);
		expect(running(tree)).toHaveLength(3);

		const nextStart = Bun.spawn([process.execPath, HOST], {
			cwd: REPO_ROOT,
			env: { ...Bun.env, LIFELINE_DIR: tmp.path(), LIFELINE_SWEEP_ONLY: "1" },
			stdout: "pipe",
			stderr: "inherit",
		});
		const report = JSON.parse(await new Response(nextStart.stdout).text());
		expect(await nextStart.exited).toBe(0);

		expect(report).toEqual([{ hostPid: host.pid, processes: 3 }]);
		expect(running(tree)).toEqual([]);
		expect((await fs.readdir(tmp.path())).filter(name => name.startsWith(`${host.pid}-`))).toEqual([]);
	}, 60_000);
});
