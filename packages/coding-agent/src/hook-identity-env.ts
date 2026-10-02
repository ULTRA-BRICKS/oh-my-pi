/**
 * Trusted subagent identity markers for agent-hooks bridges and bash children.
 *
 * `PI_SESSION_FILE` uses the nested Task/eval transcript path shape:
 *   .../<session-id>/<agent-id>.jsonl
 * `RIG_AGENT_ID` carries the registry worker id (e.g. "ThinNotSub").
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { MAIN_AGENT_ID } from "./registry/agent-registry";

export const HOOK_IDENTITY_ENV_KEYS = ["PI_SESSION_FILE", "RIG_AGENT_ID"] as const;
export const DETACHED_AGENT_ENV_KEY = "RIG_DETACHED_AGENT" as const;
export const DETACHED_PARENT_IDENTITY_ENV_KEYS = {
	sessionFile: "OMP_INTERNAL_PARENT_PI_SESSION_FILE",
	agentId: "OMP_INTERNAL_PARENT_RIG_AGENT_ID",
} as const;

export type HookIdentityEnvKey = (typeof HOOK_IDENTITY_ENV_KEYS)[number];

export interface HookIdentityEnvInput {
	suppressInheritedIdentity?: boolean;
	sessionFile?: string | null;
	agentId?: string | null;
}

export interface HookIdentity {
	sessionFile?: string;
	agentId?: string;
}

export type HookIdentityEnvSource = HookIdentityEnvInput | undefined;

export function normalizeHookIdentity(input: HookIdentityEnvSource): HookIdentity {
	const sessionFile = input?.sessionFile?.trim();
	const agentId = input?.agentId?.trim();
	// Main owns registry resources, and a session file without an agent id is not
	// an attributable hook identity. Both cases must suppress the marker pair.
	if (!agentId || agentId === MAIN_AGENT_ID) return {};
	return {
		...(sessionFile ? { sessionFile } : {}),
		agentId,
	};
}

function hasExplicitHookIdentity(input: HookIdentityEnvSource): boolean {
	return Boolean(input?.sessionFile?.trim() || input?.agentId?.trim());
}

/** Read identity inherited from the sanctioned detached launcher, never stale host state. */
export function detachedParentHookIdentity(env: Readonly<Record<string, string | undefined>>): HookIdentity {
	if (env[DETACHED_AGENT_ENV_KEY] !== "1") return {};
	return normalizeHookIdentity({
		sessionFile: env[DETACHED_PARENT_IDENTITY_ENV_KEYS.sessionFile] ?? env.PI_SESSION_FILE,
		agentId: env[DETACHED_PARENT_IDENTITY_ENV_KEYS.agentId] ?? env.RIG_AGENT_ID,
	});
}

/** Internal parent carriers are consumed before worker code or children can inherit them. */
export function clearHookIdentityWorkerCarriers(env: Record<string, string | undefined>): void {
	delete env[DETACHED_PARENT_IDENTITY_ENV_KEYS.sessionFile];
	delete env[DETACHED_PARENT_IDENTITY_ENV_KEYS.agentId];
}

export function resolveHookIdentity(explicit: HookIdentityEnvSource, inherited: HookIdentityEnvSource): HookIdentity {
	if (explicit?.suppressInheritedIdentity === true) return {};
	if (hasExplicitHookIdentity(explicit)) return normalizeHookIdentity(explicit);
	return normalizeHookIdentity(inherited);
}

export function hasHookIdentity(identity: HookIdentityEnvSource): boolean {
	const normalized = normalizeHookIdentity(identity);
	return normalized.sessionFile !== undefined || normalized.agentId !== undefined;
}

export function sameHookIdentity(a: HookIdentityEnvSource, b: HookIdentityEnvSource): boolean {
	const left = normalizeHookIdentity(a);
	const right = normalizeHookIdentity(b);
	return left.sessionFile === right.sessionFile && left.agentId === right.agentId;
}

/** Build env entries for a subagent/worker session. Omits blank values. */
export function buildHookIdentityEnv(input: HookIdentityEnvInput): Record<string, string> {
	const identity = normalizeHookIdentity(input);
	const env: Record<string, string> = {};
	if (identity.sessionFile) env.PI_SESSION_FILE = identity.sessionFile;
	if (identity.agentId) env.RIG_AGENT_ID = identity.agentId;
	return env;
}

/** Absent fields must remove identity left by an earlier retained-worker run. */
export function syncHookIdentityEnv(env: Record<string, string | undefined>, identity: HookIdentityEnvSource): void {
	const patch = buildHookIdentityEnv(normalizeHookIdentity(identity));
	for (const key of HOOK_IDENTITY_ENV_KEYS) {
		const value = patch[key];
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
}

/**
 * Build an isolated-worker environment. Host markers are never trusted as an explicit
 * overlay; detached parent values are captured separately before the public markers
 * are cleared, so a later absent snapshot cannot retain an earlier explicit identity.
 */
export function buildHookIdentityWorkerEnv(
	base: Record<string, string>,
	explicit: HookIdentityEnvSource,
): Record<string, string> {
	base = { ...base };
	const inherited: HookIdentity = explicit?.suppressInheritedIdentity === true ? {} : detachedParentHookIdentity(base);
	for (const key of HOOK_IDENTITY_ENV_KEYS) delete base[key];
	clearHookIdentityWorkerCarriers(base);
	if (explicit?.suppressInheritedIdentity === true) delete base[DETACHED_AGENT_ENV_KEY];
	if (base[DETACHED_AGENT_ENV_KEY] === "1") {
		base[DETACHED_PARENT_IDENTITY_ENV_KEYS.sessionFile] = inherited.sessionFile ?? "";
		base[DETACHED_PARENT_IDENTITY_ENV_KEYS.agentId] = inherited.agentId ?? "";
	}
	const effective = resolveHookIdentity(explicit, inherited);
	return { ...base, ...buildHookIdentityEnv(effective) };
}

/** Merge hook identity after caller overlays so identity cannot be accidentally shadowed. */
export function mergeHookIdentityEnv(
	base: Record<string, string> | undefined,
	identity: HookIdentityEnvInput,
): Record<string, string> | undefined {
	const patch = buildHookIdentityEnv(identity);
	if (!base && Object.keys(patch).length === 0) return undefined;
	const merged = { ...base };
	syncHookIdentityEnv(merged, identity);
	return merged;
}

const hookIdentityScope = new AsyncLocalStorage<HookIdentity>();

/**
 * Snapshot each handler invocation so concurrent child hooks never share host markers.
 * The compatibility-only legacy HookRunner is intentionally outside this scope: it
 * does not carry the owning agent identity that the ExtensionRunner provides.
 */
export function withHookIdentity<T>(identity: HookIdentityEnvSource, handler: () => T): T {
	return hookIdentityScope.run(normalizeHookIdentity(identity), handler);
}

export function filterStringEnvironment(source: Readonly<Record<string, unknown>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

/** A full subprocess environment is needed to remove inherited stale identity fields. */
export function getHookInvocationEnv(): NodeJS.ProcessEnv | undefined {
	const identity = hookIdentityScope.getStore();
	if (identity === undefined) return undefined;
	const env = filterStringEnvironment(process.env);
	syncHookIdentityEnv(env, identity);
	return env;
}
