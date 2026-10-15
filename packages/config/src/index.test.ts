import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	ConfigError,
	collectConfigWarnings,
	configHome,
	defaultStatePath,
	keychainReference,
	LATCH_CHANNEL,
	loadConfig,
	normalizeConfig,
	presetAgentConfig,
	resolveKeychainReferences,
	stateHome,
	withBuiltins,
} from "./index.ts";

test("normalizes defaults across agents and channels", () => {
	const config = normalizeConfig({
		agents: {
			local: {
				command: "acp-agent",
			},
		},
		channels: {
			inbox: {
				type: "webhook",
				permissions: {
					inbound: {
						mode: "open",
					},
				},
			},
		},
	});

	expect(config.defaults.agent).toBe("local");
	expect(config.channels.inbox?.agent).toBe("local");
	expect(config.channels.inbox?.session.strategy).toBe("perConversation");
	expect(config.channels.inbox?.delivery.mode).toBe("bufferUntilTurnEnd");
	expect(config.channels.inbox?.intake.mode).toBe("awaitTurn");
	expect(config.state.driver).toBe("sqlite");
});

test("a config file has the latch channel first and, without agents, every preset", () => {
	const empty = normalizeConfig(withBuiltins({}));

	expect(Object.keys(empty.channels)).toEqual(["latch"]);
	expect(empty.channels.latch).toMatchObject(LATCH_CHANNEL);
	expect(Object.keys(empty.agents)).toEqual(["claude", "codex", "opencode"]);

	const own = normalizeConfig(
		withBuiltins({
			agents: { mine: { command: "my-agent" } },
			channels: {
				hooks: { type: "webhook" },
				latch: { linkTtlSeconds: 120 },
			},
		}),
	);

	expect(Object.keys(own.channels)).toEqual(["latch", "hooks"]);
	expect(own.channels.latch).toMatchObject({
		...LATCH_CHANNEL,
		linkTtlSeconds: 120,
	});
	expect(Object.keys(own.agents)).toEqual(["mine"]);

	expect(
		Object.keys(
			normalizeConfig(
				withBuiltins({
					channels: { latch: false, hooks: { type: "webhook" } },
				}),
			).channels,
		),
	).toEqual(["hooks"]);
});

test("the user's own config, before setup writes it, is the built-ins; another missing config is an error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-config-"));
	const previous = process.env.ACPANTENNA_CONFIG_DIR;

	process.env.ACPANTENNA_CONFIG_DIR = dir;

	try {
		const config = await loadConfig({ configPath: join(dir, "config.json") });

		expect(Object.keys(config.channels)).toEqual(["latch"]);
		await expect(
			loadConfig({ configPath: join(dir, "elsewhere.json") }),
		).rejects.toThrow();
	} finally {
		if (previous === undefined) {
			delete process.env.ACPANTENNA_CONFIG_DIR;
		} else {
			process.env.ACPANTENNA_CONFIG_DIR = previous;
		}

		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty allowlist is warned about only on channels that take inbound messages", () => {
	const config = normalizeConfig({
		agents: { local: { command: "acp-agent" } },
		channels: {
			chat: { type: "matrix" },
			web: {
				type: "relay",
				relayUrl: "wss://relay.example",
				webOrigin: "https://app.example",
			},
		},
	});
	const takesInbound = (type: string) => ({ matrix: true, relay: false })[type];

	expect(
		collectConfigWarnings(config, { takesInbound }).map(
			(warning) => warning.path,
		),
	).toEqual(["channels.chat.permissions.inbound.allow"]);
	// Without knowing the channel types, every channel is checked.
	expect(collectConfigWarnings(config)).toHaveLength(2);
});

test("resolves and validates the intake mode", () => {
	const config = normalizeConfig({
		agents: { local: { command: "acp-agent" } },
		channels: {
			inbox: {
				type: "webhook",
				intake: { mode: "ackFast" },
				permissions: { inbound: { mode: "open" } },
			},
		},
	});

	expect(config.channels.inbox?.intake.mode).toBe("ackFast");

	expect(() =>
		normalizeConfig({
			agents: { local: { command: "acp-agent" } },
			channels: { inbox: { type: "webhook", intake: { mode: "later" } } },
		}),
	).toThrow(ConfigError);
});

test("resolves and validates the delivery mode", () => {
	const config = normalizeConfig({
		agents: { local: { command: "acp-agent" } },
		channels: {
			inbox: {
				type: "webhook",
				delivery: { mode: "streamChunks" },
				permissions: { inbound: { mode: "open" } },
			},
		},
	});

	expect(config.channels.inbox?.delivery.mode).toBe("streamChunks");

	expect(() =>
		normalizeConfig({
			agents: { local: { command: "acp-agent" } },
			channels: {
				inbox: { type: "webhook", delivery: { mode: "bogus" } },
			},
		}),
	).toThrow(ConfigError);
});

test("reports useful validation errors", () => {
	expect(() => normalizeConfig({ agents: {}, channels: {} })).toThrow(
		ConfigError,
	);
});

test("rehydrates sessions from the last 7 days by default, per-channel overridable", () => {
	const config = normalizeConfig({
		agents: { local: { command: "acp-agent" } },
		defaults: { session: { rehydrateWithinDays: 3 } },
		channels: {
			inbox: { type: "webhook" },
			quiet: { type: "webhook", session: { rehydrateOnStart: false } },
		},
	});

	expect(config.defaults.session.rehydrateOnStart).toBe(true);
	expect(config.channels.inbox?.session.rehydrateWithinDays).toBe(3);
	expect(config.channels.quiet?.session.rehydrateOnStart).toBe(false);
	expect(config.channels.inbox?.delivery.pushIdleMs).toBe(1500);

	expect(() =>
		normalizeConfig({
			agents: { local: { command: "acp-agent" } },
			defaults: { session: { rehydrateWithinDays: 0 } },
			channels: { inbox: { type: "webhook" } },
		}),
	).toThrow(ConfigError);
	expect(() =>
		normalizeConfig({
			agents: { local: { command: "acp-agent" } },
			channels: {
				inbox: { type: "webhook", session: { rehydrateOnStart: "yes" } },
			},
		}),
	).toThrow(ConfigError);
});

test("runs a preset's ACP adapter, pinned, with bun x", () => {
	const environment = { bun: "/opt/bun", which: () => null };

	expect(presetAgentConfig("claude", environment)).toEqual({
		type: "stdio",
		command: "/opt/bun",
		args: ["x", "@agentclientprotocol/claude-agent-acp@0.90.0"],
		env: {},
	});
	expect(presetAgentConfig("codex", environment)?.args).toEqual([
		"x",
		"@agentclientprotocol/codex-acp@2.2.2",
	]);
	expect(presetAgentConfig("gemini")).toBeUndefined();
	expect(presetAgentConfig("constructor")).toBeUndefined();
});

test("OpenCode runs the opencode installed, else its pinned package", () => {
	expect(
		presetAgentConfig("opencode", {
			bun: "/opt/bun",
			which: (command) =>
				command === "opencode" ? "/usr/local/bin/opencode" : null,
		}),
	).toEqual({
		type: "stdio",
		command: "/usr/local/bin/opencode",
		args: ["acp"],
		env: {},
	});
	expect(
		presetAgentConfig("opencode", { bun: "/opt/bun", which: () => null }),
	).toEqual({
		type: "stdio",
		command: "/opt/bun",
		args: ["x", "opencode-ai@1.19.0", "acp"],
		env: {},
	});
});

test("an agent can be a preset, its command filled in and overridable", () => {
	const config = normalizeConfig({
		agents: {
			claude: { preset: "claude" },
			mine: { preset: "codex", args: ["x", "my-codex-acp"], cwd: "/work" },
		},
		channels: { inbox: { type: "webhook" } },
	});

	expect(config.agents.claude).toMatchObject({
		preset: "claude",
		command: process.execPath,
		args: ["x", "@agentclientprotocol/claude-agent-acp@0.90.0"],
	});
	expect(config.agents.mine).toMatchObject({
		command: process.execPath,
		args: ["x", "my-codex-acp"],
		cwd: resolve("/work"),
	});
	expect(() =>
		normalizeConfig({
			agents: { other: { preset: "gemini" } },
			channels: { inbox: { type: "webhook" } },
		}),
	).toThrow("agents.other.preset must be one of claude, codex, opencode.");
});

test("state defaults to a directory of the config's own under the state home", () => {
	const env = { ACPANTENNA_STATE_DIR: "/state" };
	const configs = join(resolve("/state"), "configs");
	const a = defaultStatePath({
		cwd: "/somewhere",
		configPath: "/a/config.ts",
		env,
	});
	const b = defaultStatePath({
		cwd: "/elsewhere",
		configPath: "/b/config.ts",
		env,
	});

	expect(dirname(dirname(a))).toBe(configs);
	expect(basename(dirname(a))).toMatch(/^[0-9a-f]{16}$/);
	expect(basename(a)).toBe("acpantenna.sqlite");
	expect(b).not.toBe(a);
	// Where the gateway runs does not matter; which config it runs does.
	expect(
		defaultStatePath({ cwd: "/elsewhere", configPath: "/a/config.ts", env }),
	).toBe(a);
	expect(defaultStatePath({ cwd: "/somewhere", env })).toBe(
		join(configs, "inline", "acpantenna.sqlite"),
	);
});

test("user directories follow each OS: XDG, then %LOCALAPPDATA% / %APPDATA% on Windows, else ~/.local/state and ~/.config", () => {
	const windows = {
		LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
		APPDATA: "C:\\Users\\me\\AppData\\Roaming",
	};

	expect(stateHome(windows, "win32")).toBe(
		join(windows.LOCALAPPDATA, "acpantenna"),
	);
	expect(configHome(windows, "win32")).toBe(
		join(windows.APPDATA, "acpantenna"),
	);
	// Not on macOS or Linux, which use the XDG layout.
	expect(stateHome(windows, "darwin")).toBe(
		join(homedir(), ".local", "state", "acpantenna"),
	);
	expect(configHome({}, "linux")).toBe(
		join(homedir(), ".config", "acpantenna"),
	);
	// XDG wins everywhere, and the acpantenna override over it.
	expect(stateHome({ ...windows, XDG_STATE_HOME: "/xdg" }, "win32")).toBe(
		join("/xdg", "acpantenna"),
	);
	expect(
		configHome(
			{ XDG_CONFIG_HOME: "/xdg", ACPANTENNA_CONFIG_DIR: "/mine" },
			"darwin",
		),
	).toBe(resolve("/mine"));
});

test("a database already in .acpantenna/ where the gateway runs is kept", () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-legacy-"));

	try {
		mkdirSync(join(dir, ".acpantenna"));
		writeFileSync(join(dir, ".acpantenna", "acpantenna.sqlite"), "");

		expect(defaultStatePath({ cwd: dir, configPath: "config.ts" })).toBe(
			join(dir, ".acpantenna", "acpantenna.sqlite"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an explicit state.path is taken relative to where the gateway runs", () => {
	const config = normalizeConfig(
		{
			agents: { local: { command: "acp-agent" } },
			channels: { inbox: { type: "webhook" } },
			state: { path: "data/state.sqlite" },
		},
		{ cwd: "/srv/gateway" },
	);

	expect(config.state).toEqual({
		driver: "sqlite",
		path: resolve("/srv/gateway", "data", "state.sqlite"),
	});
});

test("keychain references are read from the keychain, which is only asked when there are any", async () => {
	const asked: string[] = [];
	const store = {
		get: async (name: string) => {
			asked.push(name);
			return name === "matrix.password" ? "hunter2" : null;
		},
		set: async () => undefined,
	};

	expect(
		await resolveKeychainReferences(
			{
				channels: {
					matrix: {
						password: keychainReference("matrix.password"),
						userId: "@bot:matrix.org",
						note: `not ${keychainReference("matrix.password")} on its own`,
					},
				},
			},
			store,
		),
	).toEqual({
		channels: {
			matrix: {
				password: "hunter2",
				userId: "@bot:matrix.org",
				note: `not ${keychainReference("matrix.password")} on its own`,
			},
		},
	});
	expect(asked).toEqual(["matrix.password"]);

	asked.length = 0;
	await resolveKeychainReferences({ agents: { a: { command: "x" } } }, store);
	expect(asked).toEqual([]);

	await expect(
		resolveKeychainReferences({ token: keychainReference("gone") }, store),
	).rejects.toThrow('The keychain has no "gone"');
});
