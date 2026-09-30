/**
 * Host probe for the process lifeline (issue #12). Starts the lifeline the way
 * omp startup does, then runs each command in `LIFELINE_COMMANDS` (JSON array)
 * through the real `BashTool` — the in-process shell every subagent's bash call
 * uses — plus, optionally, `LIFELINE_PTY_COMMAND` on a native `PtySession` (the
 * interactive bash path) and a launch-tool daemon with `persist: true`. It
 * prints `ready` and then waits to be killed, or with
 * `LIFELINE_DEATH=native-abort` dies from `abort()` on a fresh native thread:
 * no JS handler runs either way.
 *
 * With `LIFELINE_SWEEP_ONLY=1` it instead plays the next omp start: it runs the
 * startup sweep and prints what was reaped as JSON.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { PtySession } from "@oh-my-pi/pi-natives";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Settings } from "../../src/config/settings";
import { startProcessLifeline } from "../../src/exec/lifeline";
import { createDaemonBrokerClient } from "../../src/launch/client";

const dir = Bun.env.LIFELINE_DIR;
if (!dir) throw new Error("LIFELINE_DIR is required");

if (Bun.env.LIFELINE_SWEEP_ONLY === "1") {
	process.stdout.write(`${JSON.stringify(await startProcessLifeline(dir))}\n`);
	process.exit(0);
}

await startProcessLifeline(dir);

const session = {
	cwd: dir,
	hasUI: false,
	skills: [],
	getSessionFile: () => null,
	getSessionId: () => "lifeline-host",
	getAgentId: () => null,
	asyncJobManager: new AsyncJobManager({ retentionMs: 0 }),
	settings: Settings.isolated(),
	getClientBridge: () => undefined,
} as unknown as ToolSession;

const tool = new BashTool(session);
const commands: string[] = JSON.parse(Bun.env.LIFELINE_COMMANDS ?? "[]");
for (const [index, command] of commands.entries()) {
	// Not awaited: the commands run until the host dies. A failure to start
	// surfaces as the parent's pid-file wait timing out, so say why.
	void tool.execute(`lifeline-${index}`, { command }).catch(error => {
		process.stderr.write(`lifeline-host: command ${index} failed: ${error}\n`);
	});
}

const ptyCommand = Bun.env.LIFELINE_PTY_COMMAND;
if (ptyCommand) {
	void new PtySession().start({ command: ptyCommand, cwd: dir, cols: 80, rows: 24 }).catch(error => {
		process.stderr.write(`lifeline-host: PTY command failed: ${error}\n`);
	});
}

const daemonScript = Bun.env.LIFELINE_PERSIST_DAEMON;
if (daemonScript) {
	const runtimeDir = `${dir}/launch-runtime`;
	const client = await createDaemonBrokerClient(dir, { runtimeDir, idleGraceMs: 100 });
	await client.request({
		op: "start",
		spec: {
			name: "lifeline-persist",
			application: "/bin/sh",
			args: ["-c", daemonScript],
			env: {},
			cwd: dir,
			pty: false,
			restart: "no",
			persist: true,
			detached: false,
		},
	});
}

process.stdout.write("ready\n");

if (Bun.env.LIFELINE_DEATH === "native-abort") {
	// Wait for the parent to confirm the commands are up, then abort() on a new
	// native thread, like the 2026-09-29 crash in a tokio worker.
	for await (const _ of console) break;
	const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
		dlsym: { args: [FFIType.i64, FFIType.cstring], returns: FFIType.ptr },
		pthread_create: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const rtldDefault = process.platform === "darwin" ? -2 : 0;
	const abort = libc.symbols.dlsym(rtldDefault, Buffer.from("abort\0"));
	const thread = new BigUint64Array(1);
	libc.symbols.pthread_create(ptr(thread), null, abort, null);
}
await Bun.sleep(600_000);
