#!/usr/bin/env bun
/// <reference types="bun" />
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelDefinition } from "@acpantenna/channel";
import {
	CHANNEL_COMMON_CONFIG_SCHEMA,
	ConfigError,
	collectConfigWarnings,
	defineConfig,
	loadConfig,
} from "@acpantenna/config";
import { AcpAntennaGateway, createStateStore } from "@acpantenna/core";
import { createTelemetry } from "@acpantenna/observability";

import { ArgsError, type CliOptions, parseArgs } from "./args.ts";
import { builtinChannels } from "./channels.ts";
import {
	type CliContext,
	connectCommand,
	killCommand,
	listCommand,
	revokeCommand,
} from "./connections.ts";
import { stateHome } from "./paths.ts";
import { startServer } from "./server.ts";
import { clackPrompter, SetupCancelled, setupCommand } from "./setup.ts";

export { builtinChannels };

/**
 * What `channels --json` prints: every registered channel type with its own
 * config fields (secrets marked), plus the fields every channel takes.
 */
export function describeChannels(definitions: ChannelDefinition[]) {
	return {
		version: 1,
		common: CHANNEL_COMMON_CONFIG_SCHEMA,
		channels: definitions.map((definition) => ({
			type: definition.type,
			name: definition.name,
			...(definition.description
				? { description: definition.description }
				: {}),
			capabilities: definition.capabilities ?? {},
			config: definition.configSchema,
		})),
	};
}

/** The file that runs this CLI, so it can start its own background server. */
const CLI_ENTRY = import.meta.path;

export async function main(
	argv: string[] = process.argv.slice(2),
	context: CliContext = {
		entry: CLI_ENTRY,
		interactive: process.stdout.isTTY === true,
	},
): Promise<void> {
	try {
		const parsed = parseArgs(argv);
		const command = parsed.options.help
			? "help"
			: (parsed.command ?? (parsed.options.server ? "serve" : "help"));
		const [target] = parsed.positionals;

		switch (command) {
			case "serve":
				await serve(parsed.options);
				return;
			case "init":
				await initConfig();
				return;
			case "doctor":
				await doctor(parsed.options);
				return;
			case "channels":
				await listChannels(parsed.options);
				return;
			case "sessions":
				await listSessions(parsed.options);
				return;
			case "setup":
				await setupCommand(parsed.options, clackPrompter(), {
					channels: builtinChannels,
				});
				return;
			case "connect":
				await connectCommand(target, parsed.options, context);
				return;
			case "ls":
				await listCommand(parsed.options, context);
				return;
			case "kill":
				await killCommand(target, parsed.options, context);
				return;
			case "revoke":
				await revokeCommand(parsed.options, context);
				return;
			case "server":
				await runServer(parsed.options);
				return;
			case "help":
			case "--help":
			case "-h":
				printHelp();
				return;
			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exitCode = 1;
		}
	} catch (error) {
		if (error instanceof SetupCancelled) {
			// clack has said so already.
		} else if (error instanceof ArgsError) {
			console.error(error.message);
			printHelp();
		} else if (error instanceof ConfigError) {
			console.error("Config error:");
			for (const issue of error.issues) {
				console.error(`- ${issue}`);
			}
		} else if (error instanceof Error) {
			console.error(error.message);
		} else {
			console.error(String(error));
		}

		process.exitCode = 1;
	}
}

async function serve(options: CliOptions): Promise<void> {
	const config = await loadConfig({
		configPath: options.config,
		serverOverride: options.server,
	});

	const telemetry = createTelemetry();
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: Object.fromEntries(
			builtinChannels.map((definition) => [definition.type, definition.create]),
		),
	});

	await gateway.start();

	const server = Bun.serve({
		hostname: config.server.host,
		port: config.server.port,
		fetch: gateway.fetch,
	});

	console.log(
		`acpantenna listening on http://${server.hostname}:${server.port}`,
	);
	console.log(
		telemetry.exporterKind === "none"
			? "Telemetry: off (set OTEL_EXPORTER_OTLP_ENDPOINT, or OTEL_TRACES_EXPORTER=console)"
			: `Telemetry: OpenTelemetry traces via ${telemetry.exporterKind}`,
	);
	console.log("Press Ctrl+C to stop.");

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		server.stop();
		await gateway.stop();
		await telemetry.shutdown();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	await new Promise<void>(() => undefined);
}

/**
 * `acpantenna server`: the background server `connect` starts for a config.
 * It stops once its last connection is dropped.
 */
async function runServer(options: CliOptions): Promise<void> {
	if (!options.config) {
		throw new Error("server needs --config <path>.");
	}

	// Started from inside an agent's terminal session, it must not look like
	// part of that session to the agents it starts.
	delete process.env.CLAUDECODE;
	delete process.env.CLAUDE_CODE_ENTRYPOINT;

	let stopping = false;
	const server = await startServer({
		configPath: resolve(options.config),
		stateDir: stateHome(),
		onIdle: () => void shutdown(),
		onShutdown: () => void shutdown(),
	});
	const shutdown = async () => {
		if (stopping) {
			return;
		}

		stopping = true;
		await server.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	console.log(
		`acpantenna server on ${server.socketPath}${server.url ? `, channels on ${server.url}` : ""}`,
	);

	await new Promise<void>(() => undefined);
}

async function initConfig(): Promise<void> {
	const targetPath = resolve(process.cwd(), "acpantenna.config.ts");

	if (existsSync(targetPath)) {
		throw new Error("acpantenna.config.ts already exists.");
	}

	await Bun.write(
		targetPath,
		`import { defineConfig } from "@acpantenna/config";

export default defineConfig({
	// The latch channel, the web client at latch.im, is built in; "latch":
	// false turns it off. Add Matrix or a webhook here: see the README.
	channels: {},
	// Without agents, claude, codex and opencode are built in.
});
`,
	);

	console.log("Created acpantenna.config.ts");
	void defineConfig;
}

async function doctor(options: CliOptions): Promise<void> {
	const config = await loadConfig({
		configPath: options.config,
		serverOverride: options.server,
	});
	const warnings = collectConfigWarnings(config, {
		takesInbound: (type) => {
			const definition = builtinChannels.find(
				(channel) => channel.type === type,
			);

			return definition ? definition.capabilities?.inbound === true : undefined;
		},
	});

	console.log(`Config: ${config.configPath ?? "inline"}`);
	console.log(`Server: ${config.server.host}:${config.server.port}`);
	console.log(`Agents: ${Object.keys(config.agents).join(", ")}`);
	console.log(
		`Channels: ${Object.entries(config.channels)
			.map(([channelId, channel]) => `${channelId} (${channel.type})`)
			.join(", ")}`,
	);

	for (const [channelId, channel] of Object.entries(config.channels)) {
		if (
			!builtinChannels.some((definition) => definition.type === channel.type)
		) {
			warnings.push({
				path: `channels.${channelId}.type`,
				message: `No built-in channel factory is available for "${channel.type}" yet.`,
			});
		}
	}

	if (warnings.length === 0) {
		console.log("Doctor: no warnings found.");
		return;
	}

	console.log("Warnings:");
	for (const warning of warnings) {
		console.log(`- ${warning.path}: ${warning.message}`);
	}
}

async function listChannels(options: CliOptions): Promise<void> {
	// The registry, not the config: a settings UI needs it before any config
	// exists.
	if (options.json) {
		console.log(JSON.stringify(describeChannels(builtinChannels), null, 2));
		return;
	}

	const config = await loadConfig({
		configPath: options.config,
		serverOverride: options.server,
	});

	for (const [channelId, channel] of Object.entries(config.channels)) {
		console.log(
			`${channelId}\t${channel.type}\tagent=${channel.agent}\tsession=${channel.session.strategy}`,
		);
	}
}

async function listSessions(options: CliOptions): Promise<void> {
	const config = await loadConfig({
		configPath: options.config,
		serverOverride: options.server,
	});
	const stateStore = createStateStore(config);
	const sessions = await stateStore.listSessions();

	if (sessions.length === 0) {
		console.log("No sessions recorded.");
	}

	for (const session of sessions) {
		console.log(
			`${session.channelId}\t${session.sessionKey}\t${session.agentId}\t${session.acpSessionId}\t${session.updatedAt}`,
		);
	}

	await stateStore.close?.();
}

function printHelp(): void {
	console.log(`acpantenna

Usage:
  acpantenna setup [--channel name] [--config path.json]
  acpantenna connect <agent> [--session-id id [--fork]] [--channel id] [--conversation id] [--cwd dir] [--config path]
  acpantenna ls [--json]
  acpantenna kill <session id> | --conversation id [--channel id] | --all
  acpantenna revoke [--channel id] [--config path]
  acpantenna serve [--config path] [--server host:port]
  acpantenna init
  acpantenna doctor [--config path]
  acpantenna channels [--config path] [--json]
  acpantenna sessions [--config path]

Commands:
  setup      Add a channel to ~/.config/acpantenna/config.json, or change one there
  connect    Connect an agent session to a channel's conversation, in the background.
             Without --session-id a new session is started; --fork copies the session instead.
             The channel defaults to latch (the web client at latch.im), else the
             config's only one; the conversation to its defaultConversation.
             The config defaults to ./acpantenna.config.ts, else the one setup
             wrote; without either, latch and the agent presets.
  ls         List connections
  kill       Disconnect; the agent's session itself is kept
  revoke     Give relay channels a new key: every link they gave out stops working,
             and their connections are dropped
  serve      Start the gateway in the foreground
  init       Create an acpantenna.config.ts starter file
  doctor     Validate config and surface risky defaults
  channels   List configured channels (--json: every channel type and its config fields)
  sessions   List persisted channel-to-ACP session mappings
`);
}

if (import.meta.main) {
	await main();
}
