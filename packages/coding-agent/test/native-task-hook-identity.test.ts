/** Native child Bash gates must expose invocation identity to hook subprocesses. */
import { $ } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { KeybindingsManager } from "../src/config/keybindings";
import { getThemeByName } from "../src/modes/theme/theme";
import { TempDir, ptree } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async/job-manager";
import * as direnvModule from "../src/exec/direnv";
import { execCommand } from "../src/exec/exec";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper";
import { AuthStorage } from "../src/session/auth-storage";
import type { ClientBridge } from "../src/session/client-bridge";
import { SessionManager } from "../src/session/session-manager";
import * as bashInteractive from "../src/tools/bash-interactive";
import { BashTool, type BashToolDetails } from "../src/tools/bash";
import { EventBus } from "../src/utils/event-bus";

const identityCommand = `printf "%s|%s" "\${PI_SESSION_FILE-unset}" "\${RIG_AGENT_ID-unset}"`;

describe("native Task Bash hook identity", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const managers: AsyncJobManager[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("omp-native-hook-identity-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.json"));
	});

	afterEach(async () => {
		await Promise.all(managers.splice(0).map(manager => manager.dispose()));
		mock.restore();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	for (const route of ["direct", "async", "acp", "pty"] as const) {
		it(`applies the configured prefix to the user command with trusted identity over hostile direnv via ${route}`, async () => {
			const hostIdentity = [process.env.PI_SESSION_FILE, process.env.RIG_AGENT_ID];
			const settings = Settings.isolated({
				"bash.autoBackground.enabled": false,
				"async.enabled": true,
				"bashInterceptor.enabled": false,
				"bash.direnv": "auto",
			});
			const wrapper = path.resolve(tempDir.join("prefix-wrapper.sh"));
			await Bun.write(
				wrapper,
				`printf "wrapped:%s|%s|%s|%s\\n" "$1" "\${PI_SESSION_FILE-unset}" "\${RIG_AGENT_ID-unset}" "\${REMOVE_ME-unset}"; "$@"`,
			);
			spyOn(settings, "getShellConfig").mockReturnValue({
				shell: "/bin/bash",
				args: ["--noprofile", "--norc", "-c"],
				env: {},
				prefix: `/bin/bash ${$.escape(wrapper)}`,
			});
			spyOn(Settings, "init").mockResolvedValue(settings);
			spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue({
				set: { CUSTOM: "direnv", PI_SESSION_FILE: "/tmp/hostile-direnv.jsonl", RIG_AGENT_ID: "HostileDirenv" },
				unset: ["REMOVE_ME", "CUSTOM", "RIG_AGENT_ID"],
			});
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			managers.push(manager);
			const runner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				path.resolve(tempDir.path()),
				SessionManager.inMemory(path.resolve(tempDir.path())),
				modelRegistry,
				undefined,
				settings,
			);
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("Missing dark theme");
			const ui = { ...runner.getUIContext() };
			ui.custom = async <T>(factory: Parameters<typeof ui.custom<T>>[0]): Promise<T> => {
				const finished = Promise.withResolvers<T>();
				const component = await factory(
					new TUI(new VirtualTerminal(100, 30)),
					theme,
					KeybindingsManager.inMemory(),
					finished.resolve,
				);
				try {
					return await finished.promise;
				} finally {
					component.dispose?.();
				}
			};
			const context = { ...runner.createContext(), hasUI: true, ui, hasQueuedMessages: () => false };
			const bridge: ClientBridge = {
				capabilities: { terminal: true },
				createTerminal: async request => {
					const result = await ptree.exec([request.command, ...(request.args ?? [])], {
						cwd: request.cwd,
						env: {
							...process.env,
							REMOVE_ME: "stale",
							...Object.fromEntries((request.env ?? []).map(({ name, value }) => [name, value])),
						},
						timeout: 2000,
					});
					return {
						terminalId: "prefix-identity",
						waitForExit: async () => ({ exitCode: result.exitCode ?? 0, signal: null }),
						currentOutput: async () => ({ output: result.stdout, truncated: false }),
						kill: async () => {},
						release: async () => {},
					};
				},
			};
			for (const agentId of ["Child'quoted", "Main"]) {
				const sessionFile = path.resolve(tempDir.join("parent's transcript.jsonl"));
				const tool = new BashTool({
					cwd: path.resolve(tempDir.path()),
					hasUI: false,
					settings,
					getSessionFile: () => sessionFile,
					getAgentId: () => agentId,
					asyncJobManager: manager,
					getSessionSpawns: () => "*",
					getClientBridge: () => (route === "acp" ? bridge : undefined),
				});
				const result = await tool.execute(
					`prefix-${route}-${agentId}`,
					{
						command: `/usr/bin/printf 'user:%s|%s|%s' "\${PI_SESSION_FILE-unset}" "\${RIG_AGENT_ID-unset}" "$CUSTOM"`,
						env: { CUSTOM: "caller", RIG_AGENT_ID: "caller-stale", PI_SESSION_FILE: "caller-stale" },
						async: route === "async",
						pty: route === "pty",
					},
					undefined,
					undefined,
					route === "pty" ? context : undefined,
				);
				let output: string;
				if (route === "async") {
					const jobId = result.details?.async?.jobId;
					const job = jobId ? manager.getJob(jobId) : undefined;
					if (!job) throw new Error("Missing prefix regression job");
					await job.promise;
					output = job.resultText ?? "";
				} else {
					output = result.content.find(block => block.type === "text")?.text ?? "";
				}
				const expected = agentId === "Main" ? "unset|unset" : `${sessionFile}|${agentId}`;
				expect(output).toContain(`wrapped:/usr/bin/printf|${expected}|unset`);
				expect(output).toContain(`user:${expected}|caller`);
			}
			expect([process.env.PI_SESSION_FILE, process.env.RIG_AGENT_ID]).toEqual(hostIdentity);
		});
	}

	it("isolates concurrent child pre-Bash subprocesses and suppresses Main markers", async () => {
		const hostIdentity = [process.env.PI_SESSION_FILE, process.env.RIG_AGENT_ID];
		const observations = new Map<string, string>();
		const ready = Promise.withResolvers<void>();
		let entered = 0;
		const settings = Settings.isolated({
			"bash.autoBackground.enabled": false,
			"async.enabled": true,
			"bashInterceptor.enabled": false,
			"bash.direnv": "off",
		});
		spyOn(Settings, "init").mockResolvedValue(settings);
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Missing dark theme");
		const makeChild = async (agentId: string, identityPresent = true) => {
			let sessionFile: string | undefined = identityPresent
				? path.resolve(tempDir.join(`parent/${agentId}.jsonl`))
				: undefined;
			let bridge: ClientBridge | undefined;
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			managers.push(manager);
			let currentAgentId: string | null = identityPresent ? agentId : null;
			const sessionManager = SessionManager.inMemory(path.resolve(tempDir.path()));
			sessionManager.getSessionFile = () => sessionFile;
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("tool_call", async event => {
						if (event.toolName !== "bash") return;
						if (++entered === 3) ready.resolve();
						await ready.promise;
						const result = await pi.exec("/bin/bash", ["-c", identityCommand], { timeout: 2000 });
						expect(result.code).toBe(0);
						observations.set(event.toolCallId, result.stdout);
					});
				},
				path.resolve(tempDir.path()),
				new EventBus(),
				runtime,
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				path.resolve(tempDir.path()),
				sessionManager,
				modelRegistry,
				undefined,
				settings,
				undefined,
				undefined,
				() => currentAgentId,
			);
			const bashTool = new BashTool({
				cwd: path.resolve(tempDir.path()),
				hasUI: false,
				settings,
				getSessionFile: () => sessionFile ?? null,
				getAgentId: () => currentAgentId,
				asyncJobManager: manager,
				getClientBridge: () => bridge,
				getSessionId: () => agentId,
				getSessionSpawns: () => "*",
			});
			const tool = new ExtensionToolWrapper<typeof bashTool.parameters, BashToolDetails>(bashTool, runner);
			const ui = { ...runner.getUIContext() };
			let interactiveRuns = 0;
			ui.custom = async <T>(factory: Parameters<typeof ui.custom<T>>[0]): Promise<T> => {
				interactiveRuns++;
				const finished = Promise.withResolvers<T>();
				const tui = new TUI(new VirtualTerminal(100, 30));
				const component = await factory(tui, theme, KeybindingsManager.inMemory(), finished.resolve);
				try {
					return await finished.promise;
				} finally {
					component.dispose?.();
				}
			};
			return {
				tool,
				context: { ...runner.createContext(), hasUI: true, ui, hasQueuedMessages: () => false },
				interactiveRuns: () => interactiveRuns,
				sessionFile,
				manager,
				setBridge: (value: ClientBridge | undefined) => {
					bridge = value;
				},
				clearIdentity: () => {
					sessionFile = undefined;
					currentAgentId = null;
				},
			};
		};
		const [alpha, beta, main] = await Promise.all([
			makeChild("ChildAlpha"),
			makeChild("ChildBeta"),
			makeChild("Main"),
		]);
		const results = await Promise.all([
			alpha.tool.execute("alpha", { command: identityCommand, env: { RIG_AGENT_ID: "caller-stale" } }),
			beta.tool.execute("beta", { command: identityCommand }),
			main.tool.execute("main", { command: identityCommand }),
		]);
		expect(observations.get("alpha")).toBe(`${alpha.sessionFile}|ChildAlpha`);
		expect(observations.get("beta")).toBe(`${beta.sessionFile}|ChildBeta`);
		expect(observations.get("main")).toBe("unset|unset");
		expect(results[0].content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining(`${alpha.sessionFile}|ChildAlpha`),
			}),
		);
		expect(results[1].content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining(`${beta.sessionFile}|ChildBeta`),
			}),
		);
		expect(results[2].content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("unset|unset"),
			}),
		);
		const background = await alpha.tool.execute("alpha-async", { command: identityCommand, async: true });
		const jobId = background.details?.async?.jobId;
		if (!jobId) throw new Error("Bash did not start an async job");
		const job = alpha.manager.getJob(jobId);
		if (!job) throw new Error("Bash async job was not registered");
		await job.promise;
		expect(job.resultText).toContain(`${alpha.sessionFile}|ChildAlpha`);
		expect(observations.get("alpha-async")).toBe(`${alpha.sessionFile}|ChildAlpha`);

		if (!beta.sessionFile) throw new Error("Missing child transcript");
		const betaSessionFile = beta.sessionFile;
		beta.setBridge({
			capabilities: { terminal: true },
			createTerminal: async request => {
				expect(request.env).toContainEqual({ name: "PI_SESSION_FILE", value: betaSessionFile });
				expect(request.env).toContainEqual({ name: "RIG_AGENT_ID", value: "ChildBeta" });
				return {
					terminalId: "identity-acp",
					waitForExit: async () => ({ exitCode: 0, signal: null }),
					currentOutput: async () => ({ output: "acp-done", truncated: false }),
					kill: async () => {},
					release: async () => {},
				};
			},
		});
		await beta.tool.execute("beta-acp", { command: identityCommand });
		expect(observations.get("beta-acp")).toBe(`${beta.sessionFile}|ChildBeta`);
		const pty = await alpha.tool.execute("alpha-pty", { command: identityCommand, pty: true });
		expect(observations.get("alpha-pty")).toBe(`${alpha.sessionFile}|ChildAlpha`);
		expect(pty.content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining(`${alpha.sessionFile}|ChildAlpha`),
			}),
		);
		const absent = await makeChild("Absent", false);
		alpha.clearIdentity();
		const prefixWrapper = path.resolve(tempDir.join("route-prefix.sh"));
		await Bun.write(prefixWrapper, 'printf "wrapped:%s\\n" "$1"; "$@"');
		const shellConfig = settings.getShellConfig();
		spyOn(settings, "getShellConfig").mockReturnValue({
			...shellConfig,
			prefix: `/bin/bash ${$.escape(prefixWrapper)}`,
		});
		for (const [name, child, expected] of [
			["main", main, "unset|unset"],
			["cleared", alpha, "unset|unset"],
			["absent", absent, "unset|unset"],
			["child", beta, `${beta.sessionFile}|ChildBeta`],
		] as const) {
			child.setBridge(undefined);
			for (const route of ["direct", "async", "fallback", "interactive", "acp"] as const) {
				if (route === "acp") {
					child.setBridge({
						capabilities: { terminal: true },
						createTerminal: async request => {
							const result = await ptree.exec([request.command, ...(request.args ?? [])], {
								cwd: request.cwd,
								env: {
									...process.env,
									...Object.fromEntries((request.env ?? []).map(({ name, value }) => [name, value])),
								},
								timeout: 2000,
							});
							return {
								terminalId: `identity-${name}`,
								waitForExit: async () => ({ exitCode: result.exitCode ?? 0, signal: null }),
								currentOutput: async () => ({ output: result.stdout, truncated: false }),
								kill: async () => {},
								release: async () => {},
							};
						},
					});
				}
				const callId = `${name}-${route}`;
				const result = await child.tool.execute(
					callId,
					{
						command: identityCommand,
						async: route === "async",
						pty: route === "fallback" || route === "interactive",
					},
					undefined,
					undefined,
					route === "interactive" ? child.context : undefined,
				);
				if (route === "async") {
					const jobId = result.details?.async?.jobId;
					const job = jobId ? child.manager.getJob(jobId) : undefined;
					if (!job) throw new Error("Missing async job");
					await job.promise;
					expect(job.resultText).toContain(expected);
					expect(job.resultText).toContain("wrapped:printf");
				} else {
					expect(result.content).toContainEqual(
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining(expected),
						}),
					);
					expect(result.content).toContainEqual(
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining("wrapped:printf"),
						}),
					);
				}
				expect(observations.get(callId)).toBe(expected);
			}
			expect(child.interactiveRuns()).toBe(1);
			child.setBridge(undefined);
		}
		await alpha.tool.execute("cleared", { command: identityCommand });
		expect(observations.get("cleared")).toBe("unset|unset");
		// PTY resolves global settings, independently of the tool session settings.
		const ptySettings = Settings.isolated({});
		spyOn(ptySettings, "getShellConfig").mockReturnValue({
			shell: "cmd.exe",
			args: ["/c"],
			env: {},
			prefix: undefined,
		});
		spyOn(Settings, "init").mockResolvedValue(ptySettings);
		const ptySpy = spyOn(bashInteractive, "runInteractiveBashPty").mockResolvedValue({
			output: "",
			exitCode: 0,
			cancelled: false,
			timedOut: false,
			truncated: false,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
		});
		settings.override("bash.direnv", "auto");
		spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue({ set: {}, unset: ["AWS_PROFILE", "CUSTOM"] });
		for (const child of [alpha, main, beta]) {
			const command = "echo %RIG_AGENT_ID%";
			await child.tool.execute(
				"cmd-pty",
				{
					command,
					pty: true,
					env: { RIG_AGENT_ID: "caller-stale", PI_SESSION_FILE: "caller-stale", CUSTOM: "keep" },
				},
				undefined,
				undefined,
				child.context,
			);
			const options = ptySpy.mock.calls.at(-1)![1];
			expect(options.command).toBe(command);
			expect(options.shell).toBe("cmd.exe");
			expect(options.env).toMatchObject({
				RIG_AGENT_ID: child === beta ? "ChildBeta" : "",
				PI_SESSION_FILE: child === beta ? beta.sessionFile : "",
				CUSTOM: "keep",
				AWS_PROFILE: "",
			});
		}
		const outside = await execCommand("/bin/bash", ["-c", identityCommand], path.resolve(tempDir.path()), {
			timeout: 2000,
		});
		expect(outside.stdout).toBe(`${hostIdentity[0] ?? "unset"}|${hostIdentity[1] ?? "unset"}`);
		expect([process.env.PI_SESSION_FILE, process.env.RIG_AGENT_ID]).toEqual(hostIdentity);
	});
});
