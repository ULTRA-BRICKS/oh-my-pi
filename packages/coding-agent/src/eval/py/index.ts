import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	readSetting,
	namespaceSessionId as sharedNamespace,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import type { BackendProbeOptions } from "../probe";
import { defaultEvalSessionId } from "../session-id";
import { normalizeHookIdentity, resolveHookIdentity } from "../../hook-identity-env";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

const PYTHON_SESSION_PREFIX = "python:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PYTHON_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "python.interpreter");
}

/** Resolve the retained Python kernel identity owned by a tool session. */
export function resolvePythonKernelIdentity(session: ToolSession): {
	cwd: string;
	sessionId: string;
	interpreter: string | undefined;
	kernelOwnerId: string | undefined;
	agentId: string | undefined;
	sessionFile: string | undefined;
} {
	const identity = normalizeHookIdentity({
		agentId: session.getAgentId?.() ?? undefined,
		sessionFile: session.getSessionFile?.() ?? undefined,
	});
	return {
		cwd: session.cwd,
		sessionId: namespaceSessionId(session.getEvalSessionId?.() ?? defaultEvalSessionId(session)),
		interpreter: readInterpreterSetting(session),
		kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
		agentId: identity.agentId,
		sessionFile: identity.sessionFile,
	};
}

export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession, opts?: BackendProbeOptions): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd, readInterpreterSetting(session), opts);
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = readSetting<PythonExecutorOptions["kernelMode"]>(opts.session, "python.kernelMode");
		const identity = resolvePythonKernelIdentity(opts.session);
		const effectiveIdentity = resolveHookIdentity({ sessionFile: opts.sessionFile, agentId: opts.agentId }, identity);
		const executorOptions: PythonExecutorOptions = {
			cwd: identity.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: identity.sessionId,
			kernelMode,
			interpreter: identity.interpreter,
			sessionFile: effectiveIdentity.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: resolveEvalUrlRoots(opts.session),
			kernelOwnerId: identity.kernelOwnerId,
			agentId: effectiveIdentity.agentId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			toolSession: opts.session,
		};
		const result = await executePython(code, executorOptions);
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
