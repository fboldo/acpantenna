import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChannelPairing } from "@acpantenna/channel";
import {
	AGENT_PRESETS,
	type AgentConfig,
	loadConfig,
	presetAgentConfig,
} from "@acpantenna/config";
import type { SessionMapping } from "@acpantenna/core";
import * as clack from "@clack/prompts";
import { renderUnicodeCompact } from "uqr";
import type { CliOptions } from "./args.ts";
import {
	resolveConfigPath,
	serverLogPath,
	serverPidPath,
	serverSocketPath,
	serversDir,
	stateHome,
} from "./paths.ts";
import {
	type ConfirmBody,
	type ConnectBody,
	type ConnectionListing,
	type ConnectResult,
	type DisconnectBody,
	isAlive,
	isServing,
	type RevokeBody,
	type RevokeResult,
	readPid,
	type ServerHealth,
} from "./server.ts";
import { VERSION } from "./version.ts";

/** How the CLI reaches its own entry point, to start a server with it. */
export interface CliContext {
	/** The file that runs the CLI: this source's main.ts, or a bundle of it. */
	entry: string;
	stateDir?: string;
	/** On a terminal: show progress as it happens. */
	interactive?: boolean;
	out?: (line: string) => void;
	err?: (line: string) => void;
	/**
	 * Asks the user whether the words shown on both devices match. By
	 * default a yes/no question on a terminal, else a line read from stdin.
	 */
	confirmWords?: (words: string[]) => Promise<boolean>;
}

/** A connection, with the server that holds it. */
export interface ListedConnection extends ConnectionListing {
	configPath: string;
}

const SERVER_START_TIMEOUT_MS = 30_000;
const SERVER_STOP_TIMEOUT_MS = 15_000;
const PREPARE_TIMEOUT_MS = 180_000;
const PAIRING_POLL_MS = 250;

/** `acpantenna connect <agent>`: bind a conversation to an agent session. */
export async function connectCommand(
	agent: string | undefined,
	options: CliOptions,
	context: CliContext,
): Promise<SessionMapping> {
	const out = context.out ?? console.log;

	if (!agent) {
		throw new Error(
			`Say which agent to connect: acpantenna connect <agent> (${Object.keys(AGENT_PRESETS).join(", ")}, or one from your config).`,
		);
	}

	if (options.fork && !options.sessionId) {
		throw new Error("--fork needs the --session-id to fork.");
	}

	const configPath = await resolveConfigPath(options.config);
	const config = await loadConfig({
		configPath,
		cwd: dirname(configPath),
	});
	// A config's own agent, or a preset by name: either may run a preset.
	const configured = config.agents[agent];
	const presetId = configured ? configured.preset : agent;
	const preset =
		presetId && Object.hasOwn(AGENT_PRESETS, presetId)
			? AGENT_PRESETS[presetId]
			: undefined;

	if (!preset && !configured) {
		throw new Error(
			`There is no agent "${agent}": use ${Object.keys(AGENT_PRESETS).join(" or ")}, or one from ${configPath}.`,
		);
	}

	// On a terminal, a spinner says what it is waiting for; piped, it is quiet.
	const progress =
		context.interactive && !options.json ? clack.spinner() : undefined;
	let socketPath: string | undefined;
	const body: ConnectBody = {
		agent,
		cwd: resolve(options.cwd ?? process.cwd()),
		...(options.channel ? { channel: options.channel } : {}),
		...(options.conversation ? { conversation: options.conversation } : {}),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.fork ? { fork: true } : {}),
	};
	let connection: ConnectResult;

	try {
		// What the server will run: the config's agent, else the preset.
		const launch = configured ?? presetAgentConfig(agent);
		const fetched = launch && isBunX(launch) ? launch : undefined;

		if (fetched) {
			progress?.start(`Preparing ${preset?.title ?? agent}`);
			await prepareAdapter(fetched, {
				...context,
				...(progress ? { err: () => undefined } : {}),
			});
		}

		progress?.[fetched ? "message" : "start"]("Starting the acpantenna server");
		socketPath = await ensureServer(configPath, context);

		progress?.message(
			options.sessionId
				? `${options.fork ? "Forking" : "Resuming"} ${options.sessionId}`
				: `Starting a ${agent} session`,
		);
		connection = await control<ConnectResult>(
			socketPath,
			"POST",
			"/connections",
			body,
		);
	} catch (error) {
		progress?.error("Not connected");
		throw error;
	}

	const paired = connection.pairing !== undefined;

	if (connection.pairing) {
		progress?.stop(
			`Started ${agent} session ${connection.acpSessionId} for ${connection.channelId}`,
		);

		const { pairing, ...rest } = connection;

		connection = rest;
		await pairInTerminal(socketPath, rest, pairing, {
			...context,
			interactive: progress !== undefined,
		});
	}

	if (options.json) {
		out(JSON.stringify(connection, null, 2));
		return connection;
	}

	const headline = `Connected ${agent} session ${connection.acpSessionId} to ${connection.channelId} · ${connection.conversationId}`;

	const details = [
		`directory      ${connection.cwd ?? "(the agent's own)"}`,
		...(preset?.resumeCommand
			? [
					`in a terminal  ${preset.resumeCommand.replace("{session}", connection.acpSessionId)}`,
				]
			: []),
		`disconnect     acpantenna kill ${connection.acpSessionId}`,
	];

	if (progress) {
		if (paired) {
			clack.log.success(headline);
		} else {
			progress.stop(headline);
		}

		clack.log.message(details.join("\n"));
	} else {
		out(headline);

		for (const line of details) {
			out(`  ${line}`);
		}
	}

	return connection;
}

/**
 * Pairs a connection with a remote client: shows the link and its QR code,
 * waits for the browser, shows the words, and asks whether they match. Only
 * a yes lets the browser in. Interrupted, the connection is dropped.
 */
async function pairInTerminal(
	socketPath: string,
	connection: SessionMapping,
	pairing: ChannelPairing,
	context: CliContext,
): Promise<void> {
	const out = context.out ?? console.log;
	const err = context.err ?? console.error;
	const target = {
		channel: connection.channelId,
		conversation: connection.conversationId,
	};
	const query = new URLSearchParams(target).toString();
	const drop = () =>
		control(socketPath, "POST", "/disconnect", target).catch(() => undefined);
	const interrupted = () => {
		void drop().then(() => process.exit(130));
	};

	process.once("SIGINT", interrupted);

	try {
		const expires = pairing.expiresAt
			? new Date(pairing.expiresAt).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				})
			: undefined;
		const show = context.interactive ? out : err;

		show(
			`Open this link on the device to use${expires ? ` (it works once, until ${expires})` : ""}:`,
		);
		show("");
		show(`  ${pairing.link ?? ""}`);
		show("");

		if (pairing.link && context.interactive) {
			show(renderUnicodeCompact(pairing.link, { border: 2 }));
			show("");
		}

		show("Waiting for the browser…");

		let current = pairing;

		while (current.state === "waiting") {
			await Bun.sleep(PAIRING_POLL_MS);
			current = await control<ChannelPairing>(
				socketPath,
				"GET",
				`/pairing?${query}`,
			);
		}

		if (current.state === "verifying" && current.words) {
			show(`The browser shows: ${current.words.join(" ")}`);

			const accepted = await (
				context.confirmWords ?? defaultConfirmWords(context)
			)(current.words);
			const body: ConfirmBody = { ...target, accepted };

			await control(socketPath, "POST", "/pairing/confirm", body);

			if (!accepted) {
				throw new Error("Not connected: the words were not confirmed.");
			}

			current = await control<ChannelPairing>(
				socketPath,
				"GET",
				`/pairing?${query}`,
			);
		}

		if (current.state !== "connected") {
			throw new Error(`Not connected: ${current.reason ?? "pairing ended."}`);
		}
	} catch (error) {
		await drop();
		throw error;
	} finally {
		process.off("SIGINT", interrupted);
	}
}

/** Asks on the terminal; without one, reads a line from stdin and takes `y` or `yes`. */
function defaultConfirmWords(
	context: CliContext,
): (words: string[]) => Promise<boolean> {
	return async () => {
		if (context.interactive) {
			const answer = await clack.confirm({
				message: "Do these four words match the ones in the browser?",
				initialValue: false,
			});

			return answer === true;
		}

		(context.err ?? console.error)(
			"Do these four words match the ones in the browser? (yes/no)",
		);

		for await (const line of console) {
			return /^\s*y(es)?\s*$/i.test(line);
		}

		return false;
	};
}

/** `acpantenna ls`: every connection, across every running server. */
export async function listCommand(
	options: CliOptions,
	context: CliContext,
): Promise<ListedConnection[]> {
	const out = context.out ?? console.log;
	const connections = await listConnections(context);

	if (options.json) {
		out(JSON.stringify(connections, null, 2));
		return connections;
	}

	if (connections.length === 0) {
		out("No connections.");
		return connections;
	}

	out(
		formatTable([
			[
				"SESSION",
				"AGENT",
				"CHANNEL",
				"CONVERSATION",
				"DIRECTORY",
				"LAST ACTIVE",
			],
			...connections.map((connection) => [
				connection.acpSessionId,
				connection.agentId,
				connection.channelId,
				connection.pairing
					? `${connection.conversationId} (${connection.pairing.state})`
					: connection.conversationId,
				connection.cwd ?? "",
				connection.updatedAt,
			]),
		]),
	);

	return connections;
}

/**
 * `acpantenna kill <session>`: drop a connection, by its session id (or a
 * prefix only it has), by its conversation, or all of them with `--all`.
 */
export async function killCommand(
	target: string | undefined,
	options: CliOptions,
	context: CliContext,
): Promise<ListedConnection[]> {
	const out = context.out ?? console.log;
	const connections = await listConnections(context);
	const chosen = chooseConnections(connections, target, options);

	if (chosen.length === 0) {
		out("No connections.");
	}

	for (const connection of chosen) {
		const body: DisconnectBody = { sessionId: connection.acpSessionId };

		await control(
			serverSocketPath(stateDirOf(context), connection.configPath),
			"POST",
			"/disconnect",
			body,
		);
		out(
			`Disconnected ${connection.agentId} session ${connection.acpSessionId} from ${connection.channelId} · ${connection.conversationId}`,
		);
	}

	return chosen;
}

/**
 * `acpantenna revoke`: every channel that pairs with a browser (or the one
 * named) forgets its key and drops its connections, so no link it has
 * given out works again. The next `connect` makes a new key.
 */
export async function revokeCommand(
	options: CliOptions,
	context: CliContext,
): Promise<RevokeResult> {
	const out = context.out ?? console.log;
	const configPath = await resolveConfigPath(options.config);
	const socketPath = await ensureServer(configPath, context);
	const body: RevokeBody = options.channel ? { channel: options.channel } : {};
	const result = await control<RevokeResult>(
		socketPath,
		"POST",
		"/revoke",
		body,
	);

	if (options.json) {
		out(JSON.stringify(result, null, 2));
		return result;
	}

	if (result.length === 0) {
		out("No channel pairs with a browser: nothing to revoke.");
	}

	for (const { channel, dropped } of result) {
		out(
			`Revoked ${channel}: its key is forgotten, no link it gave out works, and ${dropped.length === 1 ? "1 connection was" : `${dropped.length} connections were`} dropped.`,
		);
	}

	return result;
}

export function chooseConnections(
	connections: ListedConnection[],
	target: string | undefined,
	options: Pick<CliOptions, "all" | "channel" | "conversation">,
): ListedConnection[] {
	if (options.all) {
		return connections;
	}

	if (options.conversation) {
		const matches = connections.filter(
			(connection) =>
				connection.conversationId === options.conversation &&
				(!options.channel || connection.channelId === options.channel),
		);

		if (matches.length === 0) {
			throw new Error(
				`No connection in conversation "${options.conversation}".`,
			);
		}

		if (matches.length > 1) {
			throw new Error(
				`Conversation "${options.conversation}" is in several channels; say which with --channel.`,
			);
		}

		return matches;
	}

	if (!target) {
		throw new Error(
			"Say which connection to drop: acpantenna kill <session id>, --conversation <id>, or --all.",
		);
	}

	const exact = connections.filter(
		(connection) => connection.acpSessionId === target,
	);
	const matches =
		exact.length > 0
			? exact
			: connections.filter((connection) =>
					connection.acpSessionId.startsWith(target),
				);

	if (matches.length === 0) {
		throw new Error(`No connection to session ${target}. See acpantenna ls.`);
	}

	if (matches.length > 1) {
		throw new Error(
			`${target} starts more than one session id: ${matches.map((connection) => connection.acpSessionId).join(", ")}.`,
		);
	}

	return matches;
}

/** Every connection held by a server that is running now. */
export async function listConnections(
	context: CliContext,
): Promise<ListedConnection[]> {
	const listed: ListedConnection[] = [];

	for (const socketPath of await runningServers(stateDirOf(context))) {
		const health = await control<ServerHealth>(socketPath, "GET", "/health");
		const connections = await control<ConnectionListing[]>(
			socketPath,
			"GET",
			"/connections",
		);

		listed.push(
			...connections.map((connection) => ({
				...connection,
				configPath: health.configPath,
			})),
		);
	}

	return listed;
}

async function runningServers(stateDir: string): Promise<string[]> {
	const dir = serversDir(stateDir);

	if (!existsSync(dir)) {
		return [];
	}

	const sockets = readdirSync(dir)
		.filter((name) => name.endsWith(".sock"))
		.map((name) => join(dir, name));
	const serving = await Promise.all(sockets.map((path) => isServing(path)));

	return sockets.filter((_, index) => serving[index]);
}

/**
 * The server for a config, started in the background when it is not
 * running. It outlives this command, and stops once its last connection is
 * dropped. A server of another version is replaced: the new one picks its
 * connections up from the database.
 */
export async function ensureServer(
	configPath: string,
	context: CliContext,
): Promise<string> {
	const stateDir = stateDirOf(context);
	const socketPath = serverSocketPath(stateDir, configPath);
	const pidPath = serverPidPath(socketPath);

	if (await isServing(socketPath)) {
		const health = await control<ServerHealth>(socketPath, "GET", "/health");

		if (health.version === VERSION) {
			return socketPath;
		}

		(context.err ?? console.error)(
			`Replacing the acpantenna server: it runs ${health.version ?? "an older version"}, this is ${VERSION}.`,
		);
		await control(socketPath, "POST", "/shutdown");
		// Stopped once it no longer answers and has given up its pid file.
		await waitFor(
			async () =>
				!(await isServing(socketPath)) && readPid(pidPath) !== health.pid,
			SERVER_STOP_TIMEOUT_MS,
			`The old acpantenna server (pid ${health.pid}) did not stop.`,
		);
	}

	// Another CLI is starting it right now: wait for that one. Or it is
	// stopping, its socket closed but its channels not yet: wait for it to go,
	// then start a new one.
	const starting = readPid(pidPath);

	if (starting !== undefined && isAlive(starting)) {
		await waitFor(
			async () => (await isServing(socketPath)) || !isAlive(starting),
			SERVER_START_TIMEOUT_MS,
			`The acpantenna server (pid ${starting}) did not start.`,
		);

		if (await isServing(socketPath)) {
			return socketPath;
		}
	}

	const logPath = serverLogPath(socketPath);

	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const log = openSync(logPath, "a");
	const child = Bun.spawn({
		cmd: [process.execPath, context.entry, "server", "--config", configPath],
		cwd: dirname(configPath),
		env: { ...process.env, ACPANTENNA_STATE_DIR: stateDir },
		stdin: "ignore",
		stdout: log,
		stderr: log,
		detached: true,
		// No console window for it on Windows (as Nx and pm2 do).
		windowsHide: true,
	});

	child.unref();
	closeSync(log);

	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (await isServing(socketPath)) {
			return socketPath;
		}

		if (child.exitCode !== null) {
			// It lost the race to another server, which is the one to use.
			if (await isServing(socketPath)) {
				return socketPath;
			}

			break;
		}

		await Bun.sleep(100);
	}

	throw new Error(
		`The acpantenna server did not start. Its log (${logPath}) ends:\n${tail(logPath)}`,
	);
}

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
	message: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}

		await Bun.sleep(100);
	}

	throw new Error(message);
}

/** An agent run from its npm package, which `bun x` fetches on first use. */
function isBunX(agent: AgentConfig): boolean {
	return agent.command === process.execPath && agent.args?.[0] === "x";
}

/**
 * Fetch an agent's package before its server needs it: the first download
 * can outlast the agent's start-up timeout. With stdin closed the agent
 * exits as soon as it has started.
 */
async function prepareAdapter(
	agent: AgentConfig,
	context: CliContext,
): Promise<void> {
	const spec = agent.args?.[1] ?? agent.command;
	const child = Bun.spawn({
		cmd: [agent.command, ...(agent.args ?? [])],
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), PREPARE_TIMEOUT_MS);
	const slow = setTimeout(
		() => (context.err ?? console.error)(`Fetching ${spec}…`),
		1500,
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);

	clearTimeout(timer);
	clearTimeout(slow);

	if (code !== 0) {
		throw new Error(`Could not run ${spec}:\n${stderr.trim()}`);
	}
}

async function control<T>(
	socketPath: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`http://localhost${path}`, {
		unix: socketPath,
		method,
		...(body === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	const payload = (await response.json()) as T | { error?: string };

	if (!response.ok) {
		throw new Error(
			(payload as { error?: string }).error ??
				`The server answered ${response.status}.`,
		);
	}

	return payload as T;
}

function stateDirOf(context: CliContext): string {
	return context.stateDir ?? stateHome();
}

function tail(path: string, lines = 20): string {
	try {
		return readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-lines)
			.join("\n");
	} catch {
		return "(no log)";
	}
}

function formatTable(rows: string[][]): string {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);

	return rows
		.map((row) =>
			row
				.map((cell, column) =>
					column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
				)
				.join("  "),
		)
		.join("\n");
}
