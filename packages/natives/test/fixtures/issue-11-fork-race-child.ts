/**
 * Child process for `issue-11-fork-race.test.ts`: recreates the conditions the
 * omp host died under (oh-my-pi#11) and prints `survived` if the process lives
 * through them.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as path from "node:path";
import { grep, Shell } from "../../native/index.js";

// libmalloc's memory-pressure handler makes this call (once per process) to
// load MallocStackLogging. Calling it directly lands the registration while the
// shells below are launching commands.
const libmalloc = dlopen("/usr/lib/libSystem.B.dylib", {
	malloc_register_stack_logger: { args: [], returns: FFIType.i32 },
});

const SUBAGENTS = 8;
// A shell-level loop keeps launching external commands from native threads
// while the JS event loop is blocked; `3>&1` adds a descriptor beyond stdio.
const COMMAND =
	"for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do /usr/bin/true; /bin/sh -c 'exit 0' 3>&1; done";
const GREP_ROOT = path.join(import.meta.dir, "..", "..", "native");

const runs = Array.from({ length: SUBAGENTS }, async (_, index) => {
	const shell = new Shell();
	for (let round = 0; round < 4; round++) {
		const [result] = await Promise.all([
			shell.run({ command: COMMAND }),
			grep({ pattern: "Shell", path: GREP_ROOT, maxCount: 1 }),
		]);
		if (result.exitCode !== 0) throw new Error(`shell ${index} exited with ${result.exitCode}`);
	}
});

await Bun.sleep(30);
// Block the event loop, as the host's was (`ui.loop-blocked`), and register
// MallocStackLogging partway through.
const blockedUntil = performance.now() + 150;
let registered = false;
while (performance.now() < blockedUntil) {
	if (!registered && blockedUntil - performance.now() < 120) {
		libmalloc.symbols.malloc_register_stack_logger();
		registered = true;
	}
}
await Promise.all(runs);
console.log("survived");
