/**
 * Process lifeline: every command the bash tool (and its PTY runner) spawns
 * — in the main session and in every in-process subagent — dies with this omp
 * process, however it dies. `SIGKILL`, a native abort, or an out-of-memory
 * kill runs no cleanup code in the dying process, so ownership lives outside
 * it: natives record each spawned command in a per-process file under
 * {@link getLifelineDir}, and a tiny supervisor started here re-enters the CLI
 * as the reaper once this process is gone (`pi_shell::lifeline` has the
 * details). Each startup also sweeps what crashed omp processes left behind
 * when their supervisor died with them.
 *
 * Deliberately detached work is not owned: `nohup cmd &`, daemons that start
 * their own session and reparent away (the `rig-detached-*` launchers), and
 * launch-tool daemons all survive.
 */
import { type LifelineReapedHost, lifelineReapAfterHostExit, lifelineStart, lifelineSweep } from "@oh-my-pi/pi-natives";
import { getLifelineDir, logger } from "@oh-my-pi/pi-utils";
import { LIFELINE_REAP_WORKER_ARG } from "../cli/worker-selectors";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";

/** How long the reaper waits for its host to finish exiting once the lifeline closed. */
const HOST_EXIT_WAIT_MS = 2_000;

function logReaped(reaped: LifelineReapedHost[]): void {
	for (const host of reaped) {
		logger.warn("Stopped processes left running by an omp process that died without cleanup", {
			hostPid: host.hostPid,
			processes: host.processes,
		});
	}
}

/**
 * Tie this process's shell commands to its lifetime and reap what dead omp
 * processes left running. Resolves to the hosts whose leftovers were stopped;
 * never rejects (a lifeline failure must not block startup).
 */
export async function startProcessLifeline(dir: string = getLifelineDir()): Promise<LifelineReapedHost[]> {
	const reaper = resolveWorkerSpawnCmd(LIFELINE_REAP_WORKER_ARG);
	try {
		lifelineStart(dir, reaper.cmd, reaper.cwd);
	} catch (error) {
		logger.warn("Process lifeline unavailable: commands may outlive a crash of this process", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		const reaped = await lifelineSweep(dir);
		logReaped(reaped);
		return reaped;
	} catch (error) {
		logger.warn("Process lifeline sweep failed", { error: error instanceof Error ? error.message : String(error) });
		return [];
	}
}

/** One-line user notice for a startup sweep, or `undefined` when nothing was stopped. */
export function describeReapedHosts(reaped: LifelineReapedHost[]): string | undefined {
	const total = reaped.reduce((sum, host) => sum + host.processes, 0);
	if (total === 0) return undefined;
	const pids = reaped.map(host => host.hostPid).join(", ");
	return `Stopped ${total} ${total === 1 ? "process" : "processes"} left running by a crashed omp (pid ${pids}).`;
}

/** Reaper entry (`__omp_worker_lifeline_reap <dir> <record>`), exec'd by the supervisor. */
export async function runLifelineReaper(args: string[]): Promise<void> {
	const [dir, record] = args;
	if (!dir || !record) {
		process.stderr.write("Error: lifeline reaper needs <dir> <record>\n");
		process.exitCode = 1;
		return;
	}
	logReaped(await lifelineReapAfterHostExit(dir, record, HOST_EXIT_WAIT_MS));
}
