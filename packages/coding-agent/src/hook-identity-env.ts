/**
 * Trusted subagent identity markers for agent-hooks bridges and bash children.
 *
 * `PI_SESSION_FILE` uses the nested Task/eval transcript path shape:
 *   .../<session-id>/<agent-id>.jsonl
 * `RIG_AGENT_ID` carries the registry worker id (e.g. "ThinNotSub").
 */

export const HOOK_IDENTITY_ENV_KEYS = ["PI_SESSION_FILE", "RIG_AGENT_ID"] as const;

export type HookIdentityEnvKey = (typeof HOOK_IDENTITY_ENV_KEYS)[number];

export interface HookIdentityEnvInput {
	sessionFile?: string | null;
	agentId?: string | null;
}

/** Build env entries for a subagent/worker session. Omits blank values. */
export function buildHookIdentityEnv(input: HookIdentityEnvInput): Record<string, string> {
	const env: Record<string, string> = {};
	const sessionFile = input.sessionFile?.trim();
	const agentId = input.agentId?.trim();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (agentId) env.RIG_AGENT_ID = agentId;
	return env;
}

/** Merge hook identity after caller overlays so identity cannot be accidentally shadowed. */
export function mergeHookIdentityEnv(
	base: Record<string, string> | undefined,
	identity: HookIdentityEnvInput,
): Record<string, string> | undefined {
	const patch = buildHookIdentityEnv(identity);
	if (Object.keys(patch).length === 0) return base;
	return { ...(base ?? {}), ...patch };
}
