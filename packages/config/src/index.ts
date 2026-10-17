import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as self from "./index.ts";

export type AgentTransport = "stdio";
export type SessionStrategy =
	| "perConversation"
	| "perSender"
	| "manualKeyTemplate";
export type InboundPermissionMode = "closed" | "allowlist" | "open";
export type ToolPermissionMode = "deny" | "allowTrusted" | "ask";
export type StateDriver = "memory" | "sqlite";
export type DeliveryMode =
	| "bufferUntilTurnEnd"
	| "streamChunks"
	| "debounceChunks"
	| "sendEvents";
export type IntakeMode = "awaitTurn" | "ackFast";

export interface ServerConfig {
	host?: string;
	port?: number;
}

export interface McpServerConfig {
	name: string;
	type?: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Array<{ name: string; value: string }>;
}

export interface AgentAuthConfig {
	/** The ACP auth method id to authenticate with, as advertised by the agent. */
	methodId: string;
}

export interface AgentConfig {
	type?: AgentTransport;
	/**
	 * A built-in agent (`claude`, `codex`, `opencode`, `hermes`) that runs its
	 * ACP adapter; `command` and `args`, when given, replace the preset's.
	 */
	preset?: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	default?: boolean;
	mcpServers?: string[];
	auth?: AgentAuthConfig;
}

export interface SessionPolicyConfig {
	strategy?: SessionStrategy;
	keyTemplate?: string;
	idleTtlSeconds?: number;
	/**
	 * Re-attach stored sessions (`session/resume`, else `session/load`, never a
	 * new session) when `serve` starts, so the agent can push to conversations
	 * nobody has written in since the restart. Default true.
	 */
	rehydrateOnStart?: boolean;
	/** Only rehydrate sessions used within this many days. Default 7. */
	rehydrateWithinDays?: number;
}

export interface InboundPermissionConfig {
	mode?: InboundPermissionMode;
	allow?: string[];
}

export interface PermissionPolicyConfig {
	inbound?: InboundPermissionConfig;
	toolCalls?: ToolPermissionMode;
	/**
	 * How long to wait for a user's answer to an `ask`-mode permission prompt
	 * before denying it. Default 120s.
	 */
	interactionTimeoutSeconds?: number;
}

export interface DeliveryRetryConfig {
	/** Maximum send attempts per message, including the first. Default 3. */
	maxAttempts?: number;
	/** Base backoff between retries, doubled per attempt. Default 250ms. */
	backoffMs?: number;
}

export interface DeliveryPolicyConfig {
	/**
	 * How ACP output is delivered to the channel:
	 * - `bufferUntilTurnEnd` (default): accumulate chunks, send one message at turn end.
	 * - `streamChunks`: send each chunk as it arrives.
	 * - `debounceChunks`: batch chunks and flush after `debounceMs` of quiet (and at turn end).
	 * - `sendEvents`: forward every ACP session update as an event (with its raw payload).
	 */
	mode?: DeliveryMode;
	/** Quiet period before a `debounceChunks` batch is flushed. Default 300ms. */
	debounceMs?: number;
	/**
	 * Quiet period before text the agent pushed between turns is sent as one
	 * message. A chunk marked `_meta["acpantenna/push"].final` flushes at once. Default 1500ms.
	 */
	pushIdleMs?: number;
	retry?: DeliveryRetryConfig;
}

export interface ResolvedDeliveryConfig {
	mode: DeliveryMode;
	debounceMs: number;
	pushIdleMs: number;
	retry: Required<DeliveryRetryConfig>;
}

export interface IntakePolicyConfig {
	/**
	 * How the gateway acknowledges an inbound event. `awaitTurn` (default) holds
	 * the channel's ack until the ACP turn completes; `ackFast` persists the event
	 * and returns immediately, processing the turn asynchronously (recommended for
	 * slow agents and webhook-style channels).
	 */
	mode?: IntakeMode;
}

export interface ResolvedIntakeConfig {
	mode: IntakeMode;
}

export interface ChannelConfig {
	type: string;
	agent?: string;
	/** The conversation `acpantenna connect` binds when none is given. */
	defaultConversation?: string;
	session?: SessionPolicyConfig;
	permissions?: PermissionPolicyConfig;
	delivery?: DeliveryPolicyConfig;
	intake?: IntakePolicyConfig;
	[key: string]: unknown;
}

export interface StateConfig {
	driver?: StateDriver;
	path?: string;
}

export interface AcpAntennaDefaultsConfig {
	agent?: string;
	session?: SessionPolicyConfig;
	permissions?: PermissionPolicyConfig;
	delivery?: DeliveryPolicyConfig;
	intake?: IntakePolicyConfig;
}

/** An agent as a config writes it: a preset needs no `command`. */
export type AgentInput = Omit<AgentConfig, "command"> & { command?: string };

export interface AcpAntennaConfig {
	server?: ServerConfig;
	/** Without any, every preset: `claude`, `codex`, `opencode` and `hermes`. */
	agents?: Record<string, AgentInput>;
	/**
	 * The built-in `latch` channel is always there unless set to `false`; an
	 * object named `latch` changes its settings.
	 */
	channels?: Record<string, ChannelConfig | false>;
	defaults?: AcpAntennaDefaultsConfig;
	mcpServers?: McpServerConfig[];
	state?: StateConfig;
}

export type ResolvedSessionPolicyConfig = Required<
	Pick<
		SessionPolicyConfig,
		"strategy" | "rehydrateOnStart" | "rehydrateWithinDays"
	>
> &
	SessionPolicyConfig;

export interface ResolvedChannelConfig extends ChannelConfig {
	agent: string;
	session: ResolvedSessionPolicyConfig;
	permissions: Required<
		Pick<PermissionPolicyConfig, "toolCalls" | "interactionTimeoutSeconds">
	> & {
		inbound: Required<InboundPermissionConfig>;
	};
	delivery: ResolvedDeliveryConfig;
	intake: ResolvedIntakeConfig;
}

export interface ResolvedAcpAntennaConfig
	extends Omit<
		AcpAntennaConfig,
		"server" | "agents" | "channels" | "defaults" | "state" | "mcpServers"
	> {
	configPath?: string;
	agents: Record<string, AgentConfig>;
	server: Required<ServerConfig>;
	channels: Record<string, ResolvedChannelConfig>;
	defaults: Required<Pick<AcpAntennaDefaultsConfig, "agent">> & {
		session: ResolvedSessionPolicyConfig;
		permissions: Required<
			Pick<PermissionPolicyConfig, "toolCalls" | "interactionTimeoutSeconds">
		> & {
			inbound: Required<InboundPermissionConfig>;
		};
		delivery: ResolvedDeliveryConfig;
		intake: ResolvedIntakeConfig;
	};
	mcpServers: McpServerConfig[];
	state: Required<StateConfig>;
}

export interface ConfigWarning {
	path: string;
	message: string;
}

/**
 * Where secrets are kept out of the config file: the OS keychain (macOS
 * Keychain, Windows Credential Manager, libsecret on Linux), under the
 * service "acpantenna". A config refers to one as `${keychain:<name>}`.
 */
export interface SecretStore {
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
}

export const KEYCHAIN_SERVICE = "acpantenna";

export const keychain: SecretStore = {
	get: (name) => Bun.secrets.get({ service: KEYCHAIN_SERVICE, name }),
	set: (name, value) =>
		Bun.secrets.set({ service: KEYCHAIN_SERVICE, name, value }),
};

const KEYCHAIN_REFERENCE = /^\$\{keychain:([^}]+)\}$/;

/** What a config holds in place of a secret kept in the keychain. */
export function keychainReference(name: string): string {
	return `\${keychain:${name}}`;
}

export function isKeychainReference(value: unknown): boolean {
	return typeof value === "string" && KEYCHAIN_REFERENCE.test(value);
}

/**
 * Every `${keychain:<name>}` in a config, replaced by the secret it names.
 * The keychain is only asked when the config has one.
 */
export async function resolveKeychainReferences(
	value: unknown,
	store: SecretStore,
): Promise<unknown> {
	const missing: string[] = [];
	const walk = async (item: unknown): Promise<unknown> => {
		if (typeof item === "string") {
			const name = KEYCHAIN_REFERENCE.exec(item)?.[1];

			if (!name) {
				return item;
			}

			const secret = await store.get(name).catch(() => null);

			if (secret === null) {
				missing.push(name);
			}

			return secret ?? item;
		}

		if (Array.isArray(item)) {
			return await Promise.all(item.map(walk));
		}

		if (isRecord(item)) {
			const entries = await Promise.all(
				Object.entries(item).map(async ([key, child]) => [
					key,
					await walk(child),
				]),
			);

			return Object.fromEntries(entries);
		}

		return item;
	};
	const resolved = await walk(value);

	if (missing.length > 0) {
		throw new ConfigError(
			missing.map(
				(name) =>
					`The keychain has no "${name}" (service "${KEYCHAIN_SERVICE}"). Run acpantenna setup to enter it again.`,
			),
		);
	}

	return resolved;
}

export interface LoadConfigOptions {
	/** Where `${keychain:…}` references are read from; the OS keychain by default. */
	secrets?: SecretStore;
	cwd?: string;
	configPath?: string;
	serverOverride?: string;
}

const DEFAULT_SERVER: Required<ServerConfig> = {
	host: "127.0.0.1",
	port: 19773,
};

const DEFAULT_SESSION: ResolvedSessionPolicyConfig = {
	strategy: "perConversation",
	rehydrateOnStart: true,
	rehydrateWithinDays: 7,
};

const DEFAULT_PERMISSIONS: ResolvedAcpAntennaConfig["defaults"]["permissions"] =
	{
		inbound: {
			mode: "allowlist",
			allow: [],
		},
		toolCalls: "deny",
		interactionTimeoutSeconds: 120,
	};

const DEFAULT_DELIVERY: ResolvedDeliveryConfig = {
	mode: "bufferUntilTurnEnd",
	debounceMs: 300,
	pushIdleMs: 1500,
	retry: {
		maxAttempts: 3,
		backoffMs: 250,
	},
};

const DEFAULT_INTAKE: ResolvedIntakeConfig = {
	mode: "awaitTurn",
};

const DEFAULT_STATE_DRIVER: StateDriver = "sqlite";

/** Where state used to default to, beside wherever the gateway ran. */
const LEGACY_STATE_PATH = ".acpantenna/acpantenna.sqlite";

/**
 * Where acpantenna keeps what outlives a command: each config's database,
 * and the background servers' sockets and logs. In order: the
 * `ACPANTENNA_STATE_DIR` override, `XDG_STATE_HOME`, `%LOCALAPPDATA%` on
 * Windows, else `~/.local/state` — the order GitHub's `gh` uses.
 */
export function stateHome(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return userDir(env, platform, {
		override: "ACPANTENNA_STATE_DIR",
		xdg: "XDG_STATE_HOME",
		windows: "LOCALAPPDATA",
		fallback: [".local", "state"],
	});
}

/**
 * Where `acpantenna setup` writes the user's own config: the
 * `ACPANTENNA_CONFIG_DIR` override, `XDG_CONFIG_HOME`, `%APPDATA%` on
 * Windows, else `~/.config`.
 */
export function configHome(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return userDir(env, platform, {
		override: "ACPANTENNA_CONFIG_DIR",
		xdg: "XDG_CONFIG_HOME",
		windows: "APPDATA",
		fallback: [".config"],
	});
}

function userDir(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	names: { override: string; xdg: string; windows: string; fallback: string[] },
): string {
	const override = env[names.override];

	if (override) {
		return resolve(override);
	}

	const base =
		env[names.xdg] ||
		(platform === "win32" ? env[names.windows] : undefined) ||
		join(homedir(), ...names.fallback);

	return join(base, "acpantenna");
}

/**
 * A config's database when it sets no `state.path`: one directory per
 * config file under the state home, so it does not depend on where the
 * gateway runs, and two configs never share a channel's files. A database
 * already in `.acpantenna/` where it runs, the old default, is kept.
 */
export function defaultStatePath(options: {
	cwd: string;
	configPath?: string;
	env?: Record<string, string | undefined>;
}): string {
	const legacy = resolve(options.cwd, LEGACY_STATE_PATH);

	if (existsSync(legacy)) {
		return legacy;
	}

	const id = options.configPath
		? createHash("sha256")
				.update(resolve(options.cwd, options.configPath))
				.digest("hex")
				.slice(0, 16)
		: "inline";

	return join(stateHome(options.env), "configs", id, "acpantenna.sqlite");
}

const CONFIG_FILENAMES = [
	"acpantenna.config.ts",
	"acpantenna.config.mts",
	"acpantenna.config.js",
	"acpantenna.config.mjs",
	"acpantenna.config.json",
];

/**
 * A coding agent acpantenna knows how to start, and how to pick a session up
 * in again: what `connect claude` runs when the config names no "claude".
 */
export interface AgentPreset {
	title: string;
	/**
	 * The npm package that runs it, with `bun x`; a preset whose agent is
	 * distributed another way has none, and runs the command installed.
	 */
	package?: string;
	/** Pinned, so a connection does not change agent under its user. */
	version?: string;
	/** Arguments after the package, e.g. the subcommand that speaks ACP. */
	args?: string[];
	/**
	 * The agent's own command, used instead of the package when it is
	 * installed: the same version as the one in the user's terminal, over the
	 * same session store.
	 */
	installed?: { command: string; args: string[] };
	/** How to get it, for `connect` to say when a package-less preset's command is missing. */
	install?: string;
	/** How to pick a session up in the agent's own terminal UI; `{session}` is its id. */
	resumeCommand?: string;
}

export const AGENT_PRESETS: Readonly<Record<string, AgentPreset>> = {
	claude: {
		title: "Claude Code",
		package: "@agentclientprotocol/claude-agent-acp",
		version: "0.90.0",
		resumeCommand: "claude --resume {session}",
	},
	codex: {
		title: "Codex",
		package: "@agentclientprotocol/codex-acp",
		version: "2.2.2",
		resumeCommand: "codex resume {session}",
	},
	opencode: {
		title: "OpenCode",
		package: "opencode-ai",
		version: "1.19.0",
		args: ["acp"],
		installed: { command: "opencode", args: ["acp"] },
		resumeCommand: "opencode --session {session}",
	},
	// Hermes speaks ACP itself (`hermes acp`) and is installed by its own
	// script, not npm: there is no package to pin and fetch, so this preset
	// needs the `hermes` the user installed.
	hermes: {
		title: "Hermes Agent",
		installed: { command: "hermes", args: ["acp"] },
		install:
			"curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
		resumeCommand: "hermes --resume {session}",
	},
};

/** Where a preset's command is looked up, and what runs `bun x`. */
export interface PresetEnvironment {
	/** Default: the Bun acpantenna runs on, so no Node is needed. */
	bun?: string;
	/** Default: `Bun.which`. */
	which?: (command: string) => string | null;
}

/**
 * The agent a preset runs, or undefined for an id that is not one, and for a
 * preset that has no package and whose command is not installed: its own
 * command when it is installed, else its package with `bun x`.
 */
export function presetAgentConfig(
	presetId: string,
	environment: PresetEnvironment = {},
): AgentConfig | undefined {
	if (!Object.hasOwn(AGENT_PRESETS, presetId)) {
		return undefined;
	}

	const preset = AGENT_PRESETS[presetId] as AgentPreset;
	const which = environment.which ?? ((command) => Bun.which(command));
	const installed = preset.installed
		? which(preset.installed.command)
		: undefined;

	if (preset.installed && installed) {
		return {
			type: "stdio",
			command: installed,
			args: preset.installed.args,
			env: {},
		};
	}

	if (preset.package === undefined || preset.version === undefined) {
		return undefined;
	}

	return {
		type: "stdio",
		command: environment.bun ?? process.execPath,
		args: ["x", `${preset.package}@${preset.version}`, ...(preset.args ?? [])],
		env: {},
	};
}

export function defineConfig(config: AcpAntennaConfig): AcpAntennaConfig {
	return config;
}

export class ConfigError extends Error {
	public readonly issues: string[];

	public constructor(issues: string[]) {
		super(issues.join("\n"));
		this.name = "ConfigError";
		this.issues = issues;
	}
}

export async function discoverConfig(
	cwd = process.cwd(),
): Promise<string | undefined> {
	for (const fileName of CONFIG_FILENAMES) {
		const candidate = resolve(cwd, fileName);

		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

export async function loadConfig(
	options: LoadConfigOptions = {},
): Promise<ResolvedAcpAntennaConfig> {
	const cwd = options.cwd ?? process.cwd();
	const configPath = options.configPath
		? resolve(cwd, options.configPath)
		: await discoverConfig(cwd);

	if (!configPath) {
		throw new ConfigError([
			"No acpantenna config found. Create acpantenna.config.ts or pass --config <path>.",
		]);
	}

	const rawConfig = await resolveKeychainReferences(
		// The user's own config may not exist yet: the built-ins are a config.
		!existsSync(configPath) && configPath === defaultUserConfigPath()
			? {}
			: await readConfigModule(configPath),
		options.secrets ?? keychain,
	);
	const resolvedConfig = normalizeConfig(withBuiltins(rawConfig), {
		cwd,
		configPath,
	});

	if (options.serverOverride) {
		resolvedConfig.server = {
			...resolvedConfig.server,
			...parseServerAddress(options.serverOverride),
		};
	}

	return resolvedConfig;
}

/**
 * Where `setup` writes the user's own config. Until it does, the CLI uses
 * this path anyway, and it reads as an empty config: the built-in channel
 * and the agent presets.
 */
export function defaultUserConfigPath(
	env: Record<string, string | undefined> = process.env,
): string {
	return join(configHome(env), "config.json");
}

/** The channel every config has unless it turns it off: the web client at latch.im. */
export const LATCH_CHANNEL_ID = "latch";

export const LATCH_CHANNEL: ChannelConfig & {
	relayUrl: string;
	webOrigin: string;
} = {
	type: "relay",
	relayUrl: "wss://relay.latch.im",
	webOrigin: "https://latch.im",
};

/**
 * A config file with what it may leave out filled in: the `latch` channel
 * (first, so `connect` defaults to it) and, without agents of its own, the
 * presets. `loadConfig` applies it; `normalizeConfig` takes a config as it is.
 */
export function withBuiltins(rawConfig: unknown): unknown {
	if (!isRecord(rawConfig)) {
		return rawConfig;
	}

	const config = rawConfig as unknown as AcpAntennaConfig;
	const { [LATCH_CHANNEL_ID]: latch, ...channels } = isRecord(config.channels)
		? config.channels
		: {};
	const agents =
		isRecord(config.agents) && Object.keys(config.agents).length > 0
			? config.agents
			: Object.fromEntries(
					Object.keys(AGENT_PRESETS).map((id) => [id, { preset: id }]),
				);

	return {
		...config,
		agents,
		channels: {
			...(latch === false
				? {}
				: {
						[LATCH_CHANNEL_ID]: {
							...LATCH_CHANNEL,
							...(isRecord(latch) ? latch : {}),
						},
					}),
			...(channels as Record<string, ChannelConfig>),
		},
	};
}

export function normalizeConfig(
	rawConfig: unknown,
	options: { cwd?: string; configPath?: string } = {},
): ResolvedAcpAntennaConfig {
	const cwd = options.cwd ?? process.cwd();
	const expandedConfig = expandEnv(rawConfig);
	const issues: string[] = [];

	if (!isRecord(expandedConfig)) {
		throw new ConfigError(["Config must export an object."]);
	}

	const config = expandedConfig as unknown as AcpAntennaConfig;
	const agentEntries = Object.entries(config.agents ?? {});
	const channelEntries = Object.entries(config.channels ?? {}) as Array<
		[string, ChannelConfig]
	>;

	if (!isRecord(config.agents) || agentEntries.length === 0) {
		issues.push("agents must contain at least one agent.");
	}

	if (!isRecord(config.channels) || channelEntries.length === 0) {
		issues.push("channels must contain at least one channel.");
	}

	for (const [agentId, agentConfig] of agentEntries) {
		if (!isRecord(agentConfig)) {
			issues.push(`agents.${agentId} must be an object.`);
			continue;
		}

		if ((agentConfig.type ?? "stdio") !== "stdio") {
			issues.push(`agents.${agentId}.type must be "stdio" for now.`);
		}

		if (
			agentConfig.preset !== undefined &&
			!Object.hasOwn(AGENT_PRESETS, String(agentConfig.preset))
		) {
			issues.push(
				`agents.${agentId}.preset must be one of ${Object.keys(AGENT_PRESETS).join(", ")}.`,
			);
		} else if (
			agentConfig.preset === undefined &&
			!isNonEmptyString(agentConfig.command)
		) {
			issues.push(`agents.${agentId}.command is required.`);
		}

		const auth = agentConfig.auth;

		if (
			auth !== undefined &&
			(!isRecord(auth) || !isNonEmptyString(auth.methodId))
		) {
			issues.push(
				`agents.${agentId}.auth.methodId must be a non-empty string when auth is set.`,
			);
		}
	}

	for (const [channelId, channelConfig] of channelEntries) {
		if (!isRecord(channelConfig)) {
			issues.push(`channels.${channelId} must be an object.`);
			continue;
		}

		if (!isNonEmptyString(channelConfig.type)) {
			issues.push(`channels.${channelId}.type is required.`);
		}

		validateSession(
			`channels.${channelId}.session`,
			channelConfig.session,
			issues,
		);

		const session = channelConfig.session;

		if (isRecord(session) && session.idleTtlSeconds !== undefined) {
			const idleTtlSeconds = session.idleTtlSeconds;

			if (
				typeof idleTtlSeconds !== "number" ||
				!Number.isFinite(idleTtlSeconds) ||
				idleTtlSeconds <= 0
			) {
				issues.push(
					`channels.${channelId}.session.idleTtlSeconds must be a positive number.`,
				);
			}
		}

		const delivery = channelConfig.delivery;

		if (isRecord(delivery)) {
			const modes = [
				"bufferUntilTurnEnd",
				"streamChunks",
				"debounceChunks",
				"sendEvents",
			];

			if (
				delivery.mode !== undefined &&
				(typeof delivery.mode !== "string" || !modes.includes(delivery.mode))
			) {
				issues.push(
					`channels.${channelId}.delivery.mode must be one of ${modes.join(", ")}.`,
				);
			}

			if (
				delivery.pushIdleMs !== undefined &&
				(typeof delivery.pushIdleMs !== "number" ||
					!Number.isFinite(delivery.pushIdleMs) ||
					delivery.pushIdleMs < 0)
			) {
				issues.push(
					`channels.${channelId}.delivery.pushIdleMs must be a number >= 0.`,
				);
			}

			if (
				delivery.debounceMs !== undefined &&
				(typeof delivery.debounceMs !== "number" ||
					!Number.isFinite(delivery.debounceMs) ||
					delivery.debounceMs < 0)
			) {
				issues.push(
					`channels.${channelId}.delivery.debounceMs must be a number >= 0.`,
				);
			}

			const retry = delivery.retry;

			if (isRecord(retry)) {
				if (
					retry.maxAttempts !== undefined &&
					(typeof retry.maxAttempts !== "number" ||
						!Number.isInteger(retry.maxAttempts) ||
						retry.maxAttempts < 1)
				) {
					issues.push(
						`channels.${channelId}.delivery.retry.maxAttempts must be an integer >= 1.`,
					);
				}

				if (
					retry.backoffMs !== undefined &&
					(typeof retry.backoffMs !== "number" ||
						!Number.isFinite(retry.backoffMs) ||
						retry.backoffMs < 0)
				) {
					issues.push(
						`channels.${channelId}.delivery.retry.backoffMs must be a number >= 0.`,
					);
				}
			}
		}

		const intake = channelConfig.intake;

		if (
			isRecord(intake) &&
			intake.mode !== undefined &&
			intake.mode !== "awaitTurn" &&
			intake.mode !== "ackFast"
		) {
			issues.push(
				`channels.${channelId}.intake.mode must be "awaitTurn" or "ackFast".`,
			);
		}

		const permissions = channelConfig.permissions;

		if (isRecord(permissions)) {
			if (
				permissions.toolCalls !== undefined &&
				permissions.toolCalls !== "deny" &&
				permissions.toolCalls !== "allowTrusted" &&
				permissions.toolCalls !== "ask"
			) {
				issues.push(
					`channels.${channelId}.permissions.toolCalls must be "deny", "allowTrusted", or "ask".`,
				);
			}

			const timeout = permissions.interactionTimeoutSeconds;

			if (
				timeout !== undefined &&
				(typeof timeout !== "number" ||
					!Number.isFinite(timeout) ||
					timeout <= 0)
			) {
				issues.push(
					`channels.${channelId}.permissions.interactionTimeoutSeconds must be a positive number.`,
				);
			}
		}
	}

	validateSession("defaults.session", config.defaults?.session, issues);

	const defaultAgent = resolveDefaultAgent(config);

	if (defaultAgent && config.agents && !(defaultAgent in config.agents)) {
		issues.push(`defaults.agent references unknown agent "${defaultAgent}".`);
	}

	for (const [channelId, channelConfig] of channelEntries) {
		const agentId = channelConfig.agent ?? defaultAgent;

		if (!agentId) {
			issues.push(
				`channels.${channelId}.agent is required because no default agent could be resolved.`,
			);
		} else if (config.agents && !(agentId in config.agents)) {
			issues.push(
				`channels.${channelId}.agent references unknown agent "${agentId}".`,
			);
		}
	}

	const server = {
		...DEFAULT_SERVER,
		...(config.server ?? {}),
	};

	if (
		!Number.isInteger(server.port) ||
		server.port < 0 ||
		server.port > 65535
	) {
		issues.push("server.port must be an integer from 0 to 65535.");
	}

	if (!isNonEmptyString(server.host)) {
		issues.push("server.host must be a non-empty string.");
	}

	if (issues.length > 0) {
		throw new ConfigError(issues);
	}

	const resolvedDefaultAgent =
		defaultAgent ?? agentEntries[0]?.[0] ?? "default";
	const defaultSession = mergeSession(
		DEFAULT_SESSION,
		config.defaults?.session,
	);
	const defaultPermissions = mergePermissions(
		DEFAULT_PERMISSIONS,
		config.defaults?.permissions,
	);
	const defaultDelivery = mergeDelivery(
		DEFAULT_DELIVERY,
		config.defaults?.delivery,
	);
	const defaultIntake = mergeIntake(DEFAULT_INTAKE, config.defaults?.intake);
	const resolvedChannels: Record<string, ResolvedChannelConfig> = {};

	for (const [channelId, channelConfig] of channelEntries) {
		resolvedChannels[channelId] = {
			...channelConfig,
			agent: channelConfig.agent ?? resolvedDefaultAgent,
			session: mergeSession(defaultSession, channelConfig.session),
			permissions: mergePermissions(
				defaultPermissions,
				channelConfig.permissions,
			),
			delivery: mergeDelivery(defaultDelivery, channelConfig.delivery),
			intake: mergeIntake(defaultIntake, channelConfig.intake),
		};
	}

	const resolvedAgents = Object.fromEntries(
		agentEntries.map(([agentId, configured]) => {
			const agentConfig = withPreset(configured);

			return [
				agentId,
				{
					...agentConfig,
					type: agentConfig.type ?? "stdio",
					args: agentConfig.args ?? [],
					cwd: agentConfig.cwd ? resolve(cwd, agentConfig.cwd) : undefined,
					env: agentConfig.env ?? {},
				},
			];
		}),
	) as Record<string, AgentConfig>;

	return {
		configPath: options.configPath,
		server,
		agents: resolvedAgents,
		channels: resolvedChannels,
		defaults: {
			agent: resolvedDefaultAgent,
			session: defaultSession,
			permissions: defaultPermissions,
			delivery: defaultDelivery,
			intake: defaultIntake,
		},
		mcpServers: config.mcpServers ?? [],
		state: {
			driver: DEFAULT_STATE_DRIVER,
			...(config.state ?? {}),
			path: config.state?.path
				? resolve(cwd, config.state.path)
				: defaultStatePath({
						cwd,
						...(options.configPath ? { configPath: options.configPath } : {}),
					}),
		},
	};
}

export function parseServerAddress(address: string): ServerConfig {
	const trimmedAddress = address.trim();

	if (!trimmedAddress) {
		throw new ConfigError([
			"--server must be in host:port, :port, or port form.",
		]);
	}

	if (/^\d+$/.test(trimmedAddress)) {
		return { port: Number(trimmedAddress) };
	}

	const separatorIndex = trimmedAddress.lastIndexOf(":");

	if (separatorIndex === -1) {
		return { host: trimmedAddress };
	}

	const host = trimmedAddress.slice(0, separatorIndex) || DEFAULT_SERVER.host;
	const portText = trimmedAddress.slice(separatorIndex + 1);
	const port = Number(portText);

	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new ConfigError([`Invalid server port "${portText}".`]);
	}

	return { host, port };
}

export interface ConfigWarningOptions {
	/**
	 * Whether a channel type takes inbound messages, from its declared
	 * capabilities; `undefined` when the type is unknown. A channel that takes
	 * none (a relay pairs a browser with words instead) has no inbound
	 * permissions to warn about.
	 */
	takesInbound?: (type: string) => boolean | undefined;
}

export function collectConfigWarnings(
	config: ResolvedAcpAntennaConfig,
	options: ConfigWarningOptions = {},
): ConfigWarning[] {
	const warnings: ConfigWarning[] = [];

	for (const [channelId, channelConfig] of Object.entries(config.channels)) {
		if (options.takesInbound?.(channelConfig.type) === false) {
			continue;
		}

		if (channelConfig.permissions.inbound.mode === "open") {
			warnings.push({
				path: `channels.${channelId}.permissions.inbound.mode`,
				message: "Inbound events are open to all senders for this channel.",
			});
		}

		if (
			channelConfig.permissions.inbound.mode === "allowlist" &&
			channelConfig.permissions.inbound.allow.length === 0
		) {
			warnings.push({
				path: `channels.${channelId}.permissions.inbound.allow`,
				message:
					"Allowlist mode is enabled but no senders or conversations are allowed.",
			});
		}
	}

	return warnings;
}

let providingSelf = false;

/**
 * A TypeScript config imports `defineConfig` from "@acpantenna/config". From
 * npm, acpantenna is one bundled file with no such package beside it, so it
 * answers that import with this module itself.
 */
function provideSelf(): void {
	if (providingSelf) {
		return;
	}

	providingSelf = true;
	Bun.plugin({
		name: "acpantenna-config",
		setup(build) {
			build.module("@acpantenna/config", () => ({
				exports: { ...self },
				loader: "object",
			}));
		},
	});
}

async function readConfigModule(configPath: string): Promise<unknown> {
	if (configPath.endsWith(".json")) {
		return await Bun.file(configPath).json();
	}

	provideSelf();

	const configModule = (await import(
		`${pathToFileURL(configPath).href}?mtime=${Date.now()}`
	)) as {
		default?: unknown;
		config?: unknown;
	};

	return configModule.default ?? configModule.config;
}

function validateSession(
	path: string,
	session: unknown,
	issues: string[],
): void {
	if (!isRecord(session)) {
		return;
	}

	if (
		session.rehydrateOnStart !== undefined &&
		typeof session.rehydrateOnStart !== "boolean"
	) {
		issues.push(`${path}.rehydrateOnStart must be a boolean.`);
	}

	const days = session.rehydrateWithinDays;

	if (
		days !== undefined &&
		(typeof days !== "number" || !Number.isFinite(days) || days <= 0)
	) {
		issues.push(`${path}.rehydrateWithinDays must be a positive number.`);
	}
}

/** An agent with its preset's command filled in, under what it sets itself. */
function withPreset(agentConfig: AgentInput): AgentInput {
	const preset = agentConfig.preset
		? presetAgentConfig(agentConfig.preset)
		: undefined;

	if (!preset) {
		return agentConfig;
	}

	return {
		...preset,
		...agentConfig,
		command: agentConfig.command || preset.command,
		args: agentConfig.args ?? preset.args,
		env: { ...preset.env, ...agentConfig.env },
	};
}

function resolveDefaultAgent(config: AcpAntennaConfig): string | undefined {
	if (config.defaults?.agent) {
		return config.defaults.agent;
	}

	const defaultEntry = Object.entries(config.agents ?? {}).find(
		([, agentConfig]) => agentConfig.default === true,
	);

	return defaultEntry?.[0] ?? Object.keys(config.agents ?? {})[0];
}

function mergeSession(
	base: ResolvedSessionPolicyConfig,
	override: SessionPolicyConfig | undefined,
): ResolvedSessionPolicyConfig {
	return {
		...base,
		...(override ?? {}),
	};
}

function mergePermissions(
	base: ResolvedAcpAntennaConfig["defaults"]["permissions"],
	override: PermissionPolicyConfig | undefined,
): ResolvedAcpAntennaConfig["defaults"]["permissions"] {
	return {
		toolCalls: override?.toolCalls ?? base.toolCalls,
		interactionTimeoutSeconds:
			override?.interactionTimeoutSeconds ?? base.interactionTimeoutSeconds,
		inbound: {
			mode: override?.inbound?.mode ?? base.inbound.mode,
			allow: override?.inbound?.allow ?? base.inbound.allow,
		},
	};
}

function mergeDelivery(
	base: ResolvedDeliveryConfig,
	override: DeliveryPolicyConfig | undefined,
): ResolvedDeliveryConfig {
	return {
		mode: override?.mode ?? base.mode,
		debounceMs: override?.debounceMs ?? base.debounceMs,
		pushIdleMs: override?.pushIdleMs ?? base.pushIdleMs,
		retry: { ...base.retry, ...(override?.retry ?? {}) },
	};
}

function mergeIntake(
	base: ResolvedIntakeConfig,
	override: IntakePolicyConfig | undefined,
): ResolvedIntakeConfig {
	return {
		mode: override?.mode ?? base.mode,
	};
}

function expandEnv(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
			(_match, envName: string) => process.env[envName] ?? "",
		);
	}

	if (Array.isArray(value)) {
		return value.map((item) => expandEnv(item));
	}

	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, expandEnv(item)]),
		);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function requireAbsolutePath(path: string, pathName: string): void {
	if (!isAbsolute(path)) {
		throw new ConfigError([`${pathName} must be absolute.`]);
	}
}

/** A JSON-Schema-ish field, as `acpantenna channels --json` prints it. */
export interface ConfigFieldSchema {
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
	title?: string;
	description?: string;
	secret?: boolean;
	default?: unknown;
	enum?: unknown[];
	items?: ConfigFieldSchema;
	properties?: Record<string, ConfigFieldSchema>;
	required?: string[];
}

/**
 * The fields every channel takes, whatever its type, beside `type` and the
 * channel's own fields. Kept beside the defaults above so the two cannot drift
 * far; `channels --json` prints it as `common`.
 */
export const CHANNEL_COMMON_CONFIG_SCHEMA: {
	type: "object";
	properties: Record<string, ConfigFieldSchema>;
} = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			title: "Agent",
			description: "Agent id from `agents`. Defaults to the default agent.",
		},
		defaultConversation: {
			type: "string",
			title: "Default conversation",
			description:
				"The conversation `acpantenna connect` binds when none is given.",
		},
		session: {
			type: "object",
			title: "Sessions",
			properties: {
				strategy: {
					type: "string",
					enum: ["perConversation", "perSender", "manualKeyTemplate"],
					default: DEFAULT_SESSION.strategy,
				},
				keyTemplate: {
					type: "string",
					description:
						"For manualKeyTemplate: {channel}, {conversation} and {sender} are replaced.",
				},
				idleTtlSeconds: {
					type: "number",
					description: "Close a session after this long without activity.",
				},
				rehydrateOnStart: {
					type: "boolean",
					default: DEFAULT_SESSION.rehydrateOnStart,
					description:
						"Re-attach recent sessions on start so the agent can push to them.",
				},
				rehydrateWithinDays: {
					type: "number",
					default: DEFAULT_SESSION.rehydrateWithinDays,
				},
			},
		},
		permissions: {
			type: "object",
			title: "Permissions",
			properties: {
				inbound: {
					type: "object",
					properties: {
						mode: {
							type: "string",
							enum: ["closed", "allowlist", "open"],
							default: DEFAULT_PERMISSIONS.inbound.mode,
						},
						allow: {
							type: "array",
							items: { type: "string" },
							description:
								"Sender or conversation ids allowed in allowlist mode.",
						},
					},
				},
				toolCalls: {
					type: "string",
					enum: ["deny", "allowTrusted", "ask"],
					default: DEFAULT_PERMISSIONS.toolCalls,
					description:
						"How the agent's permission requests are answered. `ask` shows them in the conversation.",
				},
				interactionTimeoutSeconds: {
					type: "number",
					default: DEFAULT_PERMISSIONS.interactionTimeoutSeconds,
				},
			},
		},
		delivery: {
			type: "object",
			title: "Delivery",
			properties: {
				mode: {
					type: "string",
					enum: [
						"bufferUntilTurnEnd",
						"streamChunks",
						"debounceChunks",
						"sendEvents",
					],
					default: DEFAULT_DELIVERY.mode,
				},
				debounceMs: { type: "number", default: DEFAULT_DELIVERY.debounceMs },
				pushIdleMs: { type: "number", default: DEFAULT_DELIVERY.pushIdleMs },
				retry: {
					type: "object",
					properties: {
						maxAttempts: {
							type: "integer",
							default: DEFAULT_DELIVERY.retry.maxAttempts,
						},
						backoffMs: {
							type: "number",
							default: DEFAULT_DELIVERY.retry.backoffMs,
						},
					},
				},
			},
		},
		intake: {
			type: "object",
			title: "Intake",
			properties: {
				mode: {
					type: "string",
					enum: ["awaitTurn", "ackFast"],
					default: DEFAULT_INTAKE.mode,
				},
			},
		},
	},
};
