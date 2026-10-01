/**
 * Auto-rotation must decide on live usage data:
 *   - a stale snapshot never vouches for spare quota, and a snapshot of a window
 *     that has since reset never keeps an account looking exhausted;
 *   - rotation after a usage-limit error does not hop onto a sibling whose
 *     (freshly re-checked) usage is already exhausted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { USAGE_RANKING_MAX_AGE_MS, usageForRanking } from "@oh-my-pi/pi-ai/auth/usage-report";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PROVIDER = "openai-codex";
const WEEK_LIMIT_ID = "openai-codex:secondary";

function limit(args: { id: string; usedFraction: number; resetsAt?: number }): UsageLimit {
	const used = Math.min(Math.max(args.usedFraction, 0), 1);
	return {
		id: args.id,
		label: args.id,
		scope: { provider: PROVIDER, windowId: args.id === WEEK_LIMIT_ID ? "7d" : args.id, shared: true },
		window: { id: args.id, label: args.id, durationMs: 7 * 24 * HOUR_MS, resetsAt: args.resetsAt },
		amount: { unit: "percent", used: used * 100, limit: 100, usedFraction: used, remainingFraction: 1 - used },
		status: used >= 1 ? "exhausted" : "ok",
	};
}

function report(args: { accountId: string; fetchedAt?: number; limits: UsageLimit[] }): UsageReport {
	return {
		provider: PROVIDER,
		fetchedAt: args.fetchedAt ?? Date.now(),
		limits: args.limits,
		metadata: { accountId: args.accountId },
	};
}

describe("usageForRanking", () => {
	const now = 1_800_000_000_000;

	test("keeps a fresh report untouched", () => {
		const fresh = report({
			accountId: "a",
			fetchedAt: now - MINUTE_MS,
			limits: [limit({ id: "w", usedFraction: 0.3, resetsAt: now + HOUR_MS })],
		});
		expect(usageForRanking(fresh, now)?.limits).toEqual(fresh.limits);
	});

	test("drops an exhausted window that reset after the snapshot was taken", () => {
		const stale = report({
			accountId: "a",
			fetchedAt: now - 2 * HOUR_MS,
			limits: [limit({ id: "w", usedFraction: 1, resetsAt: now - HOUR_MS })],
		});
		expect(usageForRanking(stale, now)).toBeNull();
	});

	test("an old snapshot no longer vouches for spare quota", () => {
		const old = report({
			accountId: "a",
			fetchedAt: now - USAGE_RANKING_MAX_AGE_MS - MINUTE_MS,
			limits: [limit({ id: "w", usedFraction: 0.1, resetsAt: now + HOUR_MS })],
		});
		expect(usageForRanking(old, now)).toBeNull();
	});

	test("an old snapshot still reports a window that is exhausted until a future reset", () => {
		const old = report({
			accountId: "a",
			fetchedAt: now - 2 * HOUR_MS,
			limits: [
				limit({ id: "week", usedFraction: 1, resetsAt: now + HOUR_MS }),
				limit({ id: "short", usedFraction: 0.1, resetsAt: now + HOUR_MS }),
			],
		});
		expect(usageForRanking(old, now)?.limits.map(entry => entry.id)).toEqual(["week"]);
	});

	test("keeps an exhausted rolling window whose incremental tick has passed", () => {
		const rolling = limit({ id: "rolling", usedFraction: 1, resetsAt: now - MINUTE_MS });
		const tick = { ...rolling, window: { ...rolling.window!, id: "rolling", label: "rolling", resetLabel: "tick" } };
		const snapshot = report({ accountId: "a", fetchedAt: now - 2 * MINUTE_MS, limits: [tick] });
		expect(usageForRanking(snapshot, now)?.limits).toEqual([tick]);
	});

	test("treats a future-dated report as old instead of fresh for years", () => {
		const future = report({
			accountId: "a",
			fetchedAt: now + 365 * 24 * HOUR_MS,
			limits: [limit({ id: "w", usedFraction: 0.1, resetsAt: now + HOUR_MS })],
		});
		expect(usageForRanking(future, now)).toBeNull();
	});

	test("treats a report with an invalid fetchedAt as old", () => {
		const bad = report({
			accountId: "a",
			fetchedAt: Number.NaN,
			limits: [limit({ id: "w", usedFraction: 0.1, resetsAt: now + HOUR_MS })],
		});
		expect(usageForRanking(bad, now)).toBeNull();
	});

	test("passes null through", () => {
		expect(usageForRanking(null, now)).toBeNull();
	});
});

describe("AuthStorage rotation on live usage", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();
	const fetchCounts = new Map<string, number>();

	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			fetchCounts.set(accountId, (fetchCounts.get(accountId) ?? 0) + 1);
			return usageByAccount.get(accountId) ?? null;
		},
	};

	function credential(accountId: string): OAuthCredentials {
		return {
			access: `access-${accountId}`,
			refresh: `refresh-${accountId}`,
			expires: Date.now() + 7 * 24 * HOUR_MS,
			accountId,
			email: `${accountId}@example.com`,
		};
	}

	function requireStore(): AuthCredentialStore {
		if (!store) throw new Error("test setup failed");
		return store;
	}

	function requireStorage(): AuthStorage {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-rotation-stale-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		});
		usageByAccount.clear();
		fetchCounts.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const current = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!current?.accountId) return null;
			return { apiKey: `api-${current.accountId}`, newCredentials: current };
		});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", ...credential("acct-a") },
			{ type: "oauth", ...credential("acct-b") },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("does not rotate onto a sibling whose usage is exhausted", async () => {
		const resetsAt = Date.now() + 3 * HOUR_MS;
		usageByAccount.set(
			"acct-b",
			report({ accountId: "acct-b", limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 1, resetsAt })] }),
		);

		const outcome = await requireStorage().limits.markReached(PROVIDER, undefined, {
			apiKey: "access-acct-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(outcome.switched).toBe(false);
		expect(outcome.retryAtMs).toBe(resetsAt);
	});

	test("rotates onto a sibling whose usage still has headroom", async () => {
		usageByAccount.set(
			"acct-b",
			report({
				accountId: "acct-b",
				limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.4, resetsAt: Date.now() + HOUR_MS })],
			}),
		);

		const outcome = await requireStorage().limits.markReached(PROVIDER, undefined, {
			apiKey: "access-acct-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(outcome.switched).toBe(true);
	});

	test("treats an unreadable sibling as available instead of guessing it is exhausted", async () => {
		const outcome = await requireStorage().limits.markReached(PROVIDER, undefined, {
			apiKey: "access-acct-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(outcome.switched).toBe(true);
	});

	test("re-checks a sibling whose cached usage is too old before rotating onto it", async () => {
		const storage = requireStorage();
		usageByAccount.set(
			"acct-b",
			report({
				accountId: "acct-b",
				fetchedAt: Date.now() - 3 * MINUTE_MS,
				limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.2, resetsAt: Date.now() + HOUR_MS })],
			}),
		);
		await storage.usage.reports();
		expect(fetchCounts.get("acct-b")).toBe(1);

		usageByAccount.set(
			"acct-b",
			report({
				accountId: "acct-b",
				limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 1, resetsAt: Date.now() + 2 * HOUR_MS })],
			}),
		);
		const outcome = await storage.limits.markReached(PROVIDER, undefined, {
			apiKey: "access-acct-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(fetchCounts.get("acct-b")).toBe(2);
		expect(outcome.switched).toBe(false);
	});

	test("probes stale siblings one at a time and stops at the first with headroom", async () => {
		const storage = requireStorage();
		await storage.credentials.set(PROVIDER, [
			{ type: "oauth", ...credential("acct-a") },
			{ type: "oauth", ...credential("acct-b") },
			{ type: "oauth", ...credential("acct-c") },
			{ type: "oauth", ...credential("acct-d") },
		]);
		const staleHealthy = (accountId: string): UsageReport =>
			report({
				accountId,
				fetchedAt: Date.now() - 3 * MINUTE_MS,
				limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.2, resetsAt: Date.now() + HOUR_MS })],
			});
		for (const accountId of ["acct-b", "acct-c", "acct-d"]) usageByAccount.set(accountId, staleHealthy(accountId));
		await storage.usage.reports();
		for (const accountId of ["acct-b", "acct-c", "acct-d"]) {
			usageByAccount.set(
				accountId,
				report({
					accountId,
					limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.3, resetsAt: Date.now() + HOUR_MS })],
				}),
			);
		}

		const outcome = await storage.limits.markReached(PROVIDER, undefined, {
			apiKey: "access-acct-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(outcome.switched).toBe(true);
		expect(fetchCounts.get("acct-b")).toBe(2);
		expect(fetchCounts.get("acct-c")).toBe(1);
		expect(fetchCounts.get("acct-d")).toBe(1);
	});

	test("blocks an exhausted sibling of a provider without a ranking strategy", async () => {
		const plain = "plain-usage-provider";
		const plainReports = new Map<string, UsageReport>();
		const plainStorage = new AuthStorage(requireStore(), {
			usageProviderResolver: provider =>
				provider === plain
					? {
							id: plain,
							async fetchUsage(params) {
								return plainReports.get(params.credential.accountId ?? "") ?? null;
							},
						}
					: undefined,
		});
		await plainStorage.credentials.set(plain, [
			{ type: "oauth", ...credential("plain-a") },
			{ type: "oauth", ...credential("plain-b") },
		]);
		const resetsAt = Date.now() + HOUR_MS;
		plainReports.set("plain-b", {
			provider: plain,
			fetchedAt: Date.now(),
			limits: [{ ...limit({ id: "quota", usedFraction: 1, resetsAt }), scope: { provider: plain } }],
		});

		const outcome = await plainStorage.limits.markReached(plain, undefined, {
			apiKey: "access-plain-a",
			retryAfterMs: 30 * MINUTE_MS,
		});

		expect(outcome.switched).toBe(false);
	});

	test("ranks an account with an old snapshot behind one measured live", async () => {
		const resetsAt = Date.now() + 3 * HOUR_MS;
		usageByAccount.set(
			"acct-a",
			report({
				accountId: "acct-a",
				fetchedAt: Date.now() - 2 * HOUR_MS,
				limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.1, resetsAt })],
			}),
		);
		usageByAccount.set(
			"acct-b",
			report({ accountId: "acct-b", limits: [limit({ id: WEEK_LIMIT_ID, usedFraction: 0.4, resetsAt })] }),
		);

		const chosen = new Set<string | undefined>();
		for (let index = 0; index < 20; index += 1) {
			chosen.add(await requireStorage().keys.get(PROVIDER, `stale-${index}`));
		}

		expect([...chosen]).toEqual(["api-acct-b"]);
	});
});
