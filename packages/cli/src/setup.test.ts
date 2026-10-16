import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	keychainReference,
	loadConfig,
	type SecretStore,
} from "@acpantenna/config";
import { builtinChannels } from "./channels.ts";
import { type Prompter, parseAnswer, setupCommand } from "./setup.ts";

/** Pressing Enter on a text prompt: what it starts with is the answer. */
const ENTER = Symbol("enter");

/**
 * Answers in order. A text answer its check refuses is recorded and the next
 * one is used, as a person retypes it; everything shown is kept.
 */
function scripted(answers: unknown[]) {
	const shown: Array<{ kind: string; message: string }> = [];
	const refused: string[] = [];
	const next = (kind: string, message: string) => {
		shown.push({ kind, message: stripVTControlCharacters(message) });

		if (answers.length === 0) {
			throw new Error(`No answer scripted for ${kind}: ${message}`);
		}

		return answers.shift();
	};
	const prompter: Prompter = {
		intro: (title) => shown.push({ kind: "intro", message: title }),
		outro: (message) =>
			shown.push({ kind: "outro", message: stripVTControlCharacters(message) }),
		info: (message) => shown.push({ kind: "info", message }),
		warn: (message) => shown.push({ kind: "warn", message }),
		select: async (message, choices) => {
			const answer = next("select", message);

			if (!choices.some((choice) => choice.value === answer)) {
				throw new Error(`${String(answer)} is not offered by: ${message}`);
			}

			return answer as never;
		},
		text: async (message, options = {}) => {
			while (true) {
				const answer = next("text", message);
				const value =
					answer === ENTER ? (options.initial ?? "") : String(answer);
				const problem = options.check?.(value);

				if (!problem) {
					return value;
				}

				refused.push(problem);
			}
		},
		password: async (message) => String(next("password", message)),
		confirm: async (message) => Boolean(next("confirm", message)),
	};

	return { prompter, shown, refused, answers };
}

/** A keychain in memory, so tests never touch the real one. */
function memoryKeychain() {
	const kept = new Map<string, string>();
	const store: SecretStore = {
		get: async (name) => kept.get(name) ?? null,
		set: async (name, value) => {
			kept.set(name, value);
		},
	};

	return { store, kept };
}

function withDirs() {
	const root = mkdtempSync(join(tmpdir(), "acpantenna-setup-"));

	return {
		root,
		env: {
			ACPANTENNA_CONFIG_DIR: join(root, "config"),
			ACPANTENNA_STATE_DIR: join(root, "state"),
		},
		configPath: join(root, "config", "config.json"),
	};
}

const matrixAnswers = [
	"matrix", // kind of channel
	ENTER, // name: matrix
	ENTER, // homeserver: required, its default
	"", // user id: required → refused
	"@bot:matrix.org",
	"hunter2", // password
	"", // access token
	"passphrase", // key store passphrase
	true, // adjust optional settings
	ENTER, // device id: left out
	ENTER, // device name: left out
	false, // encryption: off
	"soon", // edit interval → refused
	"5000",
	"!room:matrix.org", // default conversation
	"@me:matrix.org, @friend:matrix.org", // who may talk
];

test("setup writes a Telegram channel: its token in the keychain, numeric ids allowed", async () => {
	const { root, env, configPath } = withDirs();
	const script = scripted([
		"telegram", // kind of channel
		ENTER, // name: telegram
		"123456789:AAE-token", // bot token
		false, // adjust optional settings
		"42", // default conversation: a private chat
		"42", // who may talk: a user id
	]);
	const keychain = memoryKeychain();

	try {
		await setupCommand({}, script.prompter, {
			channels: builtinChannels,
			secrets: keychain.store,
			env,
		});

		expect(script.answers).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8")).channels).toEqual({
			telegram: {
				type: "telegram",
				botToken: keychainReference("telegram.botToken"),
				defaultConversation: "42",
				permissions: {
					inbound: { mode: "allowlist", allow: ["42"] },
					toolCalls: "ask",
				},
			},
		});
		expect(Object.fromEntries(keychain.kept)).toEqual({
			"telegram.botToken": "123456789:AAE-token",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup writes a Matrix channel the CLI can load, its secrets in the keychain", async () => {
	const { root, env, configPath } = withDirs();
	const script = scripted([...matrixAnswers]);
	const keychain = memoryKeychain();

	try {
		expect(
			await setupCommand({}, script.prompter, {
				channels: builtinChannels,
				secrets: keychain.store,
				env,
			}),
		).toBe(configPath);
		expect(script.answers).toEqual([]);
		expect(script.refused).toEqual([
			"Bot user ID is required.",
			"Edit interval (ms) must be a number.",
		]);
		// Secrets are masked.
		expect(
			script.shown
				.filter((shown) => shown.kind === "password")
				.map((shown) => shown.message.split("\n")[0]),
		).toEqual(["Password", "Access token", "Key store passphrase"]);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			channels: {
				matrix: {
					type: "matrix",
					homeserverUrl: "https://matrix.org",
					userId: "@bot:matrix.org",
					password: keychainReference("matrix.password"),
					storePassphrase: keychainReference("matrix.storePassphrase"),
					encryption: false,
					editIntervalMs: 5000,
					defaultConversation: "!room:matrix.org",
					permissions: {
						inbound: {
							mode: "allowlist",
							allow: ["@me:matrix.org", "@friend:matrix.org"],
						},
						toolCalls: "ask",
					},
				},
			},
			agents: {
				claude: { preset: "claude" },
				codex: { preset: "codex" },
				opencode: { preset: "opencode" },
			},
		});
		// Windows has no owner-only modes; its user profile's access rules apply.
		if (process.platform !== "win32") {
			expect(statSync(configPath).mode & 0o777).toBe(0o600);
		}

		expect(Object.fromEntries(keychain.kept)).toEqual({
			"matrix.password": "hunter2",
			"matrix.storePassphrase": "passphrase",
		});
		expect(readFileSync(configPath, "utf8")).not.toContain("hunter2");

		// Loading the config reads them back.
		const config = await loadConfig({ configPath, secrets: keychain.store });
		expect(config.channels.matrix?.password).toBe("hunter2");
		expect(config.channels.matrix?.agent).toBe("claude");
		expect(config.agents.claude?.args).toEqual([
			"x",
			"@agentclientprotocol/claude-agent-acp@0.90.0",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("running setup again edits the channel, starting from what is there", async () => {
	const { root, env } = withDirs();
	const keychain = memoryKeychain();

	try {
		await setupCommand({}, scripted([...matrixAnswers]).prompter, {
			channels: builtinChannels,
			secrets: keychain.store,
			env,
		});

		const again = scripted([
			ENTER, // homeserver
			ENTER, // user id
			"", // password: keep
			"", // access token
			"", // passphrase: keep
			false, // optional settings: leave them
			"!other:matrix.org", // default conversation
			ENTER, // who may talk: keep
		]);
		const configPath = await setupCommand(
			{ channel: "matrix" },
			again.prompter,
			{ channels: builtinChannels, secrets: keychain.store, env },
		);
		const matrix = JSON.parse(readFileSync(configPath, "utf8")).channels.matrix;

		expect(again.answers).toEqual([]);
		expect(
			again.shown.find((shown) => shown.kind === "password")?.message,
		).toEndWith("(empty keeps the current one)");
		// A secret is never shown back.
		expect(JSON.stringify(again.shown)).not.toContain("hunter2");
		expect(matrix).toMatchObject({
			userId: "@bot:matrix.org",
			password: keychainReference("matrix.password"),
			storePassphrase: keychainReference("matrix.storePassphrase"),
			encryption: false,
			editIntervalMs: 5000,
			defaultConversation: "!other:matrix.org",
			permissions: {
				inbound: { allow: ["@me:matrix.org", "@friend:matrix.org"] },
			},
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a channel with HTTP routes gets a free port of its own", async () => {
	const { root, env, configPath } = withDirs();
	const script = scripted(["webhook", "hooks", ENTER, ENTER]);

	try {
		await setupCommand({}, script.prompter, {
			channels: builtinChannels,
			env,
			findFreePort: () => 41234,
		});

		const written = JSON.parse(readFileSync(configPath, "utf8"));

		expect(written.server).toEqual({ host: "127.0.0.1", port: 41234 });
		expect(written.channels.hooks.permissions.inbound.allow).toEqual([]);
		expect(script.shown).toContainEqual({
			kind: "warn",
			message:
				"Nobody is allowed yet: messages will be ignored until you add a sender id here.",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup only writes JSON", async () => {
	await expect(
		setupCommand(
			{ config: "/tmp/acpantenna.config.ts" },
			scripted([]).prompter,
			{ channels: builtinChannels },
		),
	).rejects.toThrow("setup writes JSON");
});

test("answers are typed by their field", () => {
	expect(parseAnswer("Yes", { type: "boolean" })).toBe(true);
	expect(parseAnswer("0", { type: "boolean" })).toBe(false);
	expect(parseAnswer("maybe", { type: "boolean" })).toBeUndefined();
	expect(parseAnswer("2.5", { type: "number" })).toBe(2.5);
	expect(parseAnswer("2.5", { type: "integer" })).toBeUndefined();
	expect(parseAnswer("a, b,", { type: "array" })).toEqual(["a", "b"]);
	expect(parseAnswer("x", { type: "string", enum: ["a"] })).toBeUndefined();
});

test("without a keychain, secrets stay in the config file, and setup says so", async () => {
	const { root, env, configPath } = withDirs();
	const script = scripted([...matrixAnswers]);
	const broken: SecretStore = {
		get: async () => null,
		set: async () => {
			throw new Error("no secret service");
		},
	};

	try {
		await setupCommand({}, script.prompter, {
			channels: builtinChannels,
			secrets: broken,
			env,
		});

		const matrix = JSON.parse(readFileSync(configPath, "utf8")).channels.matrix;

		expect(matrix.password).toBe("hunter2");
		expect(matrix.storePassphrase).toBe("passphrase");
		expect(script.shown).toContainEqual({
			kind: "warn",
			message:
				"No keychain to keep secrets in here (no secret service). They stay in the config file, readable only by you.",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
