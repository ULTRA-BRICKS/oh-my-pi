import { type HookIdentityEnvInput, normalizeHookIdentity } from "../../hook-identity-env";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import { defaultEvalSessionId } from "../session-id";
import { executeJs } from "./executor";

const JS_SESSION_PREFIX = "js:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, JS_SESSION_PREFIX);
}

/** Resolve the retained JavaScript kernel identity owned by a tool session. */
export function resolveJsKernelIdentity(
	session: ToolSession,
	overrides?: HookIdentityEnvInput,
): {
	sessionKey: string;
	ownerId: string | undefined;
	agentId: string | undefined;
	sessionFile: string | undefined;
	suppressInheritedIdentity: boolean;
} {
	const rawAgentId = overrides?.agentId ?? session.getAgentId?.();
	const suppressInheritedIdentity = rawAgentId?.trim() === MAIN_AGENT_ID;
	const sessionFile = overrides?.sessionFile ?? session.getSessionFile?.() ?? undefined;
	const identity = normalizeHookIdentity({ agentId: rawAgentId, sessionFile });
	return {
		sessionKey: JSON.stringify([
			namespaceSessionId(session.getEvalSessionId?.() ?? defaultEvalSessionId(session)),
			identity.agentId ?? null,
			identity.sessionFile ?? null,
		]),
		ownerId: session.getEvalKernelOwnerId?.() ?? undefined,
		agentId: identity.agentId,
		sessionFile: identity.sessionFile,
		suppressInheritedIdentity,
	};
}

export default {
	id: "js",
	label: "JavaScript",
	highlightLang: "javascript",

	async isAvailable(_session: ToolSession): Promise<boolean> {
		return true;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const identity = resolveJsKernelIdentity(opts.session, opts);
		const result = await executeJs(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: identity.sessionKey,
			kernelOwnerId: identity.ownerId,
			sessionFile: identity.sessionFile,
			agentId: identity.agentId,
			suppressInheritedIdentity: identity.suppressInheritedIdentity,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			session: opts.session,
			localRoots: resolveEvalUrlRoots(opts.session),
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
