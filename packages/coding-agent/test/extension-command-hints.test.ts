import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RegisteredCommand } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { extensionCommandToSlashCommand } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("extensionCommandToSlashCommand", () => {
	it("passes through getInlineHint and getAutocompleteDescription", () => {
		const getInlineHint = (argumentText: string) => (argumentText === "li" ? "st [provider]" : null);
		const getAutocompleteDescription = () => "3 OAuth accounts";
		const cmd: RegisteredCommand = {
			name: "accounts",
			description: "Manage OAuth accounts",
			getInlineHint,
			getAutocompleteDescription,
			handler: async () => {},
		};

		const slash = extensionCommandToSlashCommand(cmd);
		expect(slash.name).toBe("accounts");
		expect(slash.description).toBe("Manage OAuth accounts");
		expect(slash.getInlineHint).toBe(getInlineHint);
		expect(slash.getAutocompleteDescription).toBe(getAutocompleteDescription);
		expect(slash.getInlineHint?.("li")).toBe("st [provider]");
		expect(slash.getAutocompleteDescription?.()).toBe("3 OAuth accounts");
	});

	it("leaves hint callbacks undefined when the extension omits them (control case)", () => {
		const cmd: RegisteredCommand = {
			name: "plain-ext",
			description: "No TUI affordances",
			handler: async () => {},
		};

		const slash = extensionCommandToSlashCommand(cmd);
		expect(slash.getInlineHint).toBeUndefined();
		expect(slash.getAutocompleteDescription).toBeUndefined();
		expect(slash.getArgumentCompletions).toBeUndefined();
	});
});

describe("extension registerCommand hint wiring", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ext-cmd-hints-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	it("stores optional hint callbacks from pi.registerCommand", async () => {
		fs.writeFileSync(
			path.join(extensionsDir, "hinted.ts"),
			`
				export default function(pi) {
					pi.registerCommand("accounts", {
						description: "Demo extension command",
						getInlineHint: (argumentText) => argumentText === "li" ? "st [provider]" : null,
						getAutocompleteDescription: () => "live description",
						handler: async () => {},
					});
				}
			`,
		);

		const result = await loadExtensions([path.join(extensionsDir, "hinted.ts")], tempDir.path());
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const registered = runner.getRegisteredCommands().find(cmd => cmd.name === "accounts");
		expect(registered?.getInlineHint?.("li")).toBe("st [provider]");
		expect(registered?.getAutocompleteDescription?.()).toBe("live description");
	});

	it("feeds extension hints into slash autocomplete once adapted for the TUI", () => {
		const slash = extensionCommandToSlashCommand({
			name: "accounts",
			getInlineHint: argumentText => (argumentText === "li" ? "st [provider]" : null),
			handler: async () => {},
		});
		const provider = new CombinedAutocompleteProvider([slash], "/tmp");

		expect(provider.getInlineHint(["/accounts li"], 0, "/accounts li".length)).toBe("st [provider]");
	});

	it("does not synthesize hints for legacy extension commands (control case)", () => {
		const slash = extensionCommandToSlashCommand({
			name: "accounts",
			handler: async () => {},
		});
		const provider = new CombinedAutocompleteProvider([slash], "/tmp");

		expect(provider.getInlineHint(["/accounts li"], 0, "/accounts li".length)).toBeNull();
	});
});
