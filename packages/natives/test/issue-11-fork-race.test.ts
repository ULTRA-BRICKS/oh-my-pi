/**
 * Regression for https://git.hyperide.ai/ultrabricks/oh-my-pi/issues/11.
 *
 * The omp host died on a tokio worker with EXC_BREAKPOINT → SIGKILL, "BUG IN
 * CLIENT OF LIBPLATFORM: Unlock of an os_unfair_lock not owned by current
 * thread". The shell launched external commands through std's `fork()`
 * fallback (brush's `setsid` `pre_exec` hook). Every `fork()` runs libmalloc's
 * atfork handlers, which read the lazily registered MallocStackLogging hooks
 * once in prepare and again in parent; libmalloc registers those hooks from its
 * memory-pressure handler, so a registration landing in between made
 * `_malloc_fork_parent` unlock a lock that prepare never took. Commands now
 * start with `posix_spawn`, which runs no atfork handlers.
 *
 * The fixture recreates the incident in a child process: several shell
 * sessions (one per in-process subagent) and native grep run concurrently, the
 * event loop is blocked, and mid-block the fixture performs the registration
 * libmalloc's memory-pressure handler would. Before the fix most such
 * processes were SIGKILLed; registration happens once per process, so each
 * child is one independent attempt.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const FIXTURE = path.join(import.meta.dir, "fixtures", "issue-11-fork-race-child.ts");
const ATTEMPTS = 3;

async function runAttempt(): Promise<{ exitCode: number; signalCode: string | null; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, FIXTURE], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, signalCode: child.signalCode, stdout, stderr };
}

describe.skipIf(process.platform !== "darwin")("issue 11: fork race with MallocStackLogging registration", () => {
	it("keeps running shell commands when MallocStackLogging registers mid-flight", async () => {
		const attempts = await Promise.all(Array.from({ length: ATTEMPTS }, runAttempt));
		for (const attempt of attempts) {
			expect(attempt).toMatchObject({ exitCode: 0, signalCode: null, stdout: "survived\n" });
		}
	}, 60_000);
});
