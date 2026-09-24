import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const PROVIDER = "unit-omp-credential-id";
const PROVIDER_KEY = `${PROVIDER}:oauth`;
const FUTURE_BLOCK_MS = Date.now() + 60 * 60_000;

function oauthCredential(access: string) {
	return {
		type: "oauth" as const,
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${access}`,
		email: `${access}@example.com`,
	};
}

describe("AuthStorage OMP_CREDENTIAL_ID env pin", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-omp-credential-id-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER];
			if (!credential) return null;
			return { apiKey: credential.access, newCredentials: credential };
		});
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

	function storage(): AuthStorage {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage;
	}

	/**
	 * Sets `OMP_CREDENTIAL_ID` AND simulates that it came from the real
	 * process launch environment. `isLaunchEnvValue` itself is verified
	 * independently against real subprocess launches in
	 * `packages/utils/test/env.test.ts`; mocking it here isolates this
	 * suite to `resolveOAuth`'s own consumption of that trust decision,
	 * which a same-process `Bun.env` mutation cannot exercise on its own
	 * (the launch snapshot is frozen once, at module load).
	 */
	async function withPinnedEnv(id: string, fn: () => Promise<void>): Promise<void> {
		const spy = vi
			.spyOn(piUtils, "isLaunchEnvValue")
			.mockImplementation((name, value) => name === "OMP_CREDENTIAL_ID" && value === id);
		try {
			await withEnv({ OMP_CREDENTIAL_ID: id }, fn);
		} finally {
			spy.mockRestore();
		}
	}

	test("OMP_CREDENTIAL_ID=abc getApiKey throws for a non-integer id", async () => {
		await storage().credentials.set(PROVIDER, [oauthCredential("stored-access")]);

		await withPinnedEnv("abc", async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-invalid")).rejects.toThrow(
				/OMP_CREDENTIAL_ID must be a positive integer/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID not present in the real launch environment is ignored, not honored", async () => {
		// A project-local `.env`, or any other non-launch source, must not be
		// able to pin account selection. Pin id 1 to the credential that's
		// DISABLED: if the (not-launch-sourced) pin were wrongly honored,
		// resolution would throw "is disabled"; correctly ignoring it falls
		// through to the other, active credential instead — the two outcomes
		// are impossible to conflate, unlike comparing two access-token strings.
		await storage().credentials.set(PROVIDER, [oauthCredential("disabled-access"), oauthCredential("account-two")]);
		expect(await storage().credentials.disable(1, "disabled for test")).toBe(true);
		// No mock: `isLaunchEnvValue` answers for real, and this test process's
		// actual launch environment never had `OMP_CREDENTIAL_ID` — the same
		// state a hostile `.env`-only value would produce.

		await withEnv({ OMP_CREDENTIAL_ID: "1" }, async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "omp-credential-not-launch-sourced");
			expect(apiKey).toBe("account-two");
		});
	});

	test("OMP_CREDENTIAL_ID= (present but blank) is treated as unset, not a malformed id", async () => {
		await storage().credentials.set(PROVIDER, [oauthCredential("stored-access")]);

		await withPinnedEnv("", async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "omp-credential-blank");
			expect(apiKey).toBe("stored-access");
		});
	});

	test("OMP_CREDENTIAL_ID=99999 falls through to normal selection when the id matches nothing anywhere", async () => {
		// A completely unknown id (typo, deleted row) must not break this
		// provider's own credential cascade — it just means the pin does not
		// apply, so the normal ranked/only credential still resolves.
		await storage().credentials.set(PROVIDER, [oauthCredential("stored-access")]);

		await withPinnedEnv("99999", async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "omp-credential-missing");
			expect(apiKey).toBe("stored-access");
		});
	});

	test("OMP_CREDENTIAL_ID scoped to another provider does not affect this provider's resolution", async () => {
		// Credential ids are a single global sequence: pinning id 1 for
		// "anthropic" must not throw or otherwise disturb an unrelated
		// provider's normal cascade when id 1 does not belong to it.
		const anthropicProvider = "anthropic";
		await storage().credentials.set(anthropicProvider, [oauthCredential("anthropic-access")]);
		await storage().credentials.set(PROVIDER, [oauthCredential("unrelated-access")]);

		await withPinnedEnv("1", async () => {
			const apiKey = await storage().getApiKey(PROVIDER, "omp-credential-other-provider");
			expect(apiKey).toBe("unrelated-access");
		});
	});

	test("OMP_CREDENTIAL_ID selects its pinned credential, not whatever ranked selection would otherwise pick", async () => {
		// Two credentials, one fixed session id: if the pin were a no-op, both
		// `OMP_CREDENTIAL_ID=1` and `=2` would return whatever ranked/hashed
		// selection alone picks for this session — i.e. the SAME token both
		// times. Each pin returning its OWN distinct token proves the pin
		// causally drives selection.
		await storage().credentials.set(PROVIDER, [oauthCredential("account-one"), oauthCredential("account-two")]);
		const sessionId = "omp-credential-pin-vs-ranked";

		await withPinnedEnv("1", async () => {
			expect(await storage().getApiKey(PROVIDER, sessionId)).toBe("account-one");
		});
		await withPinnedEnv("2", async () => {
			expect(await storage().getApiKey(PROVIDER, sessionId)).toBe("account-two");
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when the credential is disabled", async () => {
		await storage().credentials.set(PROVIDER, [oauthCredential("disabled-access")]);
		expect(await storage().credentials.disable(1, "disabled for test")).toBe(true);

		await withPinnedEnv("1", async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-disabled")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=1 is disabled/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when the credential is blocked", async () => {
		if (!store?.upsertCredentialBlock) throw new Error("test setup failed");
		await storage().credentials.set(PROVIDER, [oauthCredential("blocked-access")]);
		store.upsertCredentialBlock({
			credentialId: 1,
			providerKey: PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		await withPinnedEnv("1", async () => {
			await expect(storage().getApiKey(PROVIDER, "omp-credential-blocked")).rejects.toThrow(
				/OMP_CREDENTIAL_ID=1 is temporarily blocked/,
			);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when a scoped block applies", async () => {
		if (!store?.upsertCredentialBlock) throw new Error("test setup failed");
		const anthropicProvider = "anthropic";
		const anthropicProviderKey = `${anthropicProvider}:oauth`;
		await storage().credentials.set(anthropicProvider, [oauthCredential("scoped-blocked-access")]);
		store.upsertCredentialBlock({
			credentialId: 1,
			providerKey: anthropicProviderKey,
			blockScope: "tier:fable",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		await withPinnedEnv("1", async () => {
			await expect(
				storage().getApiKey(anthropicProvider, "omp-credential-scoped-blocked", {
					modelId: "claude-fable-5",
				}),
			).rejects.toThrow(/OMP_CREDENTIAL_ID=1 is temporarily blocked/);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey throws when accountIds excludes the pinned credential's account", async () => {
		await storage().credentials.set(PROVIDER, [oauthCredential("gated-access")]);

		await withPinnedEnv("1", async () => {
			await expect(
				storage().getApiKey(PROVIDER, "omp-credential-account-gated", {
					accountIds: ["acc-some-other-access"],
				}),
			).rejects.toThrow(/OMP_CREDENTIAL_ID=1 is not entitled to serve model/);
		});
	});

	test("OMP_CREDENTIAL_ID=1 getApiKey succeeds when accountIds includes the pinned credential's account", async () => {
		await storage().credentials.set(PROVIDER, [oauthCredential("gated-access")]);

		await withPinnedEnv("1", async () => {
			expect(
				await storage().getApiKey(PROVIDER, "omp-credential-account-allowed", {
					accountIds: ["acc-gated-access"],
				}),
			).toBe("gated-access");
		});
	});
});
