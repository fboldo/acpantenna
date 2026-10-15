import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AcpClient } from "@acpantenna/acp";
import type { ChannelLogger, ChannelPairing } from "@acpantenna/channel";
import {
	type AgentConfig,
	LATCH_CHANNEL_ID,
	loadConfig,
	presetAgentConfig,
	type ResolvedAcpAntennaConfig,
} from "@acpantenna/config";
import { AcpAntennaGateway, type SessionMapping } from "@acpantenna/core";
import { builtinChannels } from "./channels.ts";
import { serverPidPath, serverSocketPath } from "./paths.ts";
import { VERSION } from "./version.ts";

/** What `POST /connections` takes. */
export interface ConnectBody {
	agent: string;
	channel?: string;
	conversation?: string;
	sessionId?: string;
	fork?: boolean;
	cwd?: string;
}

/** What `POST /connections` answers: the connection, and its pairing when its channel pairs. */
export interface ConnectResult extends SessionMapping {
	pairing?: ChannelPairing;
}

/** A connection as `GET /connections` lists it: how pairing stands, when its channel pairs. */
export interface ConnectionListing extends SessionMapping {
	pairing?: Pick<ChannelPairing, "state">;
}

/** What `POST /pairing/confirm` takes: the user's answer to a pairing's words. */
export interface ConfirmBody {
	channel: string;
	conversation: string;
	accepted: boolean;
}

/** What `POST /revoke` takes: one channel, else every channel that pairs. */
export interface RevokeBody {
	channel?: string;
}

/** What `POST /revoke` answers, per channel: the connections it dropped. */
export type RevokeResult = Array<{
	channel: string;
	dropped: SessionMapping[];
}>;

/** What `POST /disconnect` takes: a session id, or a conversation. */
export type DisconnectBody =
	| { sessionId: string }
	| { channel: string; conversation: string };

/** What `GET /health` answers. */
export interface ServerHealth {
	ok: true;
	pid: number;
	/** The acpantenna it runs, so a CLI of another version replaces it. */
	version: string;
	configPath: string;
	/** Where channels with HTTP routes listen, when any does. */
	url?: string;
}

export interface ServerOptions {
	configPath: string;
	stateDir: string;
	/** Called when the last connection is gone: the server has nothing left to do. */
	onIdle?: () => void;
	/** Called when a CLI asks it to stop (`POST /shutdown`), e.g. to replace it. */
	onShutdown?: () => void;
	/** The version it reports; this build's unless a test says otherwise. */
	version?: string;
	acpClientFactory?: (agentId: string, agentConfig: AgentConfig) => AcpClient;
	logger?: ChannelLogger;
}

export interface RunningServer {
	socketPath: string;
	url?: string;
	gateway: AcpAntennaGateway;
	stop(): Promise<void>;
}

/**
 * The user's background server for one config: its channels and the agents
 * connected to them, managed over a unix socket only this user can reach.
 * It never listens on TCP for that, so it cannot be driven through a port.
 */
export async function startServer(
	options: ServerOptions,
): Promise<RunningServer> {
	const socketPath = serverSocketPath(options.stateDir, options.configPath);
	const pidPath = serverPidPath(socketPath);

	await claimSocket(socketPath);
	// One server per config, even when two CLIs start one at the same moment.
	acquirePidLock(pidPath);

	try {
		return await serve(options, socketPath, pidPath);
	} catch (error) {
		rmSync(pidPath, { force: true });
		throw error;
	}
}

async function serve(
	options: ServerOptions,
	socketPath: string,
	pidPath: string,
): Promise<RunningServer> {
	const config = await loadConfig({
		configPath: options.configPath,
		cwd: dirname(options.configPath),
	});
	let settleIdle = async () => {};
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: Object.fromEntries(
			builtinChannels.map((definition) => [definition.type, definition.create]),
		),
		resolveAgent: (agentId) => presetAgentConfig(agentId),
		...(options.acpClientFactory
			? { acpClientFactory: options.acpClientFactory }
			: {}),
		...(options.logger ? { logger: options.logger } : {}),
		// A remote client that leaves may leave the server with nothing to do.
		onConnectionEnded: () => void settleIdle(),
	});

	await gateway.start();

	let channelServer: ReturnType<typeof Bun.serve> | undefined;

	try {
		channelServer = gateway.hasRoutes()
			? Bun.serve({
					hostname: config.server.host,
					port: config.server.port,
					fetch: gateway.fetch,
				})
			: undefined;
	} catch (error) {
		await gateway.stop();
		throw new Error(
			`A channel takes HTTP requests on ${config.server.host}:${config.server.port}, which is in use. Set server.port in ${options.configPath} (0 picks a free one).`,
			{ cause: error },
		);
	}

	const url = channelServer
		? `http://${channelServer.hostname}:${channelServer.port}`
		: undefined;

	// Requests being answered, and the pending stop once nothing is connected.
	let answering = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const unconnected = async () =>
		(await gateway.listConnections()).length === 0;

	// After the answer that left it idle has gone out, not before; and not
	// while another CLI is talking to it (it found the server up, so expects
	// an answer).
	settleIdle = async () => {
		const onIdle = options.onIdle;

		if (!onIdle || !(await unconnected())) {
			return;
		}

		clearTimeout(idleTimer);
		idleTimer = setTimeout(async () => {
			idleTimer = undefined;

			if (answering === 0 && (await unconnected()) && answering === 0) {
				onIdle();
			}
		}, 100);
	};

	const control = Bun.serve({
		unix: socketPath,
		fetch: async (request) => {
			// A request that comes in while the server is about to stop for
			// being idle holds it up; it is idle again once that is answered.
			const wasStopping = idleTimer !== undefined;

			clearTimeout(idleTimer);
			idleTimer = undefined;
			answering++;

			try {
				return await handleControl(request, {
					gateway,
					config,
					health: {
						ok: true,
						pid: process.pid,
						version: options.version ?? VERSION,
						configPath: options.configPath,
						...(url ? { url } : {}),
					},
					settleIdle,
					shutdown: () => {
						if (options.onShutdown) {
							// After its answer has gone out.
							setTimeout(options.onShutdown, 100);
						}
					},
				});
			} finally {
				answering--;

				if (wasStopping) {
					void settleIdle();
				}
			}
		},
	});

	return {
		socketPath,
		...(url ? { url } : {}),
		gateway,
		stop: async () => {
			await control.stop();
			channelServer?.stop(true);
			await gateway.stop();
			rmSync(socketPath, { force: true });
			rmSync(pidPath, { force: true });
		},
	};
}

async function handleControl(
	request: Request,
	context: {
		gateway: AcpAntennaGateway;
		config: ResolvedAcpAntennaConfig;
		health: ServerHealth;
		settleIdle: () => Promise<void>;
		shutdown: () => void;
	},
): Promise<Response> {
	const { pathname } = new URL(request.url);
	const route = `${request.method} ${pathname}`;

	try {
		switch (route) {
			case "GET /health":
				return Response.json(context.health);

			case "POST /shutdown":
				context.shutdown();
				return Response.json({ ok: true });

			case "GET /connections":
				return Response.json(
					(await context.gateway.listConnections()).map((connection) => {
						const pairing = context.gateway.pairing({
							channelId: connection.channelId,
							conversationId: connection.conversationId,
						});

						return pairing
							? { ...connection, pairing: { state: pairing.state } }
							: connection;
					}) satisfies ConnectionListing[],
				);

			case "GET /pairing": {
				const query = new URL(request.url).searchParams;
				const pairing = context.gateway.pairing({
					channelId: query.get("channel") ?? "",
					conversationId: query.get("conversation") ?? "",
				});

				return pairing
					? Response.json(pairing)
					: Response.json({ error: "No such pairing." }, { status: 404 });
			}

			case "POST /pairing/confirm": {
				const body = (await request.json()) as ConfirmBody;

				await context.gateway.confirmPairing(
					{ channelId: body.channel, conversationId: body.conversation },
					body.accepted === true,
				);

				return Response.json({ ok: true });
			}

			case "POST /connections": {
				const body = (await request.json()) as ConnectBody;

				try {
					return Response.json(
						await connectFromBody(context.gateway, context.config, body),
					);
				} finally {
					// A server started for a connection that failed has nothing to do.
					await context.settleIdle();
				}
			}

			case "POST /revoke": {
				const body = (await request.json()) as RevokeBody;
				const channels = body.channel
					? [body.channel]
					: Object.keys(context.config.channels).filter((channelId) =>
							context.gateway.carriesAcp(channelId),
						);
				const result: RevokeResult = [];

				try {
					for (const channel of channels) {
						result.push({
							channel,
							dropped: await context.gateway.revoke(channel),
						});
					}
				} finally {
					await context.settleIdle();
				}

				return Response.json(result);
			}

			case "POST /disconnect": {
				const body = (await request.json()) as DisconnectBody;
				const dropped = await context.gateway.disconnect(
					"sessionId" in body
						? { acpSessionId: body.sessionId }
						: { channelId: body.channel, conversationId: body.conversation },
				);

				await context.settleIdle();

				return Response.json(dropped ?? null);
			}

			default:
				return Response.json({ error: `No ${route} here.` }, { status: 404 });
		}
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 400 },
		);
	}
}

/**
 * A connect request, its channel and conversation filled in from the config.
 * A channel that pairs with a remote client gets a new conversation of its
 * own each time.
 */
async function connectFromBody(
	gateway: AcpAntennaGateway,
	config: ResolvedAcpAntennaConfig,
	body: ConnectBody,
): Promise<ConnectResult> {
	const channelIds = Object.keys(config.channels);
	// The built-in web client, unless the config turned it off.
	const channelId =
		body.channel ??
		(LATCH_CHANNEL_ID in config.channels
			? LATCH_CHANNEL_ID
			: channelIds.length === 1
				? channelIds[0]
				: undefined);

	if (!channelId) {
		throw new Error(
			`Say which channel to connect with --channel (one of: ${channelIds.join(", ")}).`,
		);
	}

	const conversationId =
		body.conversation ??
		config.channels[channelId]?.defaultConversation ??
		(gateway.carriesAcp(channelId)
			? crypto.randomUUID().split("-")[0]
			: undefined);

	if (!conversationId) {
		throw new Error(
			`Channel "${channelId}" has no defaultConversation; say which with --conversation.`,
		);
	}

	const connection = await gateway.connect({
		channelId,
		conversationId,
		agentId: body.agent,
		...(body.sessionId ? { acpSessionId: body.sessionId } : {}),
		...(body.fork ? { fork: true } : {}),
		...(body.cwd ? { cwd: body.cwd } : {}),
	});
	const pairing = gateway.pairing({ channelId, conversationId });

	return pairing ? { ...connection, pairing } : connection;
}

/**
 * Take the socket path: a socket left by a server that died is removed, one a
 * live server answers on is not.
 */
async function claimSocket(socketPath: string): Promise<void> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	// Its directory may be a shared temp one: only ever one of this user's.
	const owner = statSync(dirname(socketPath)).uid;

	if (process.getuid && owner !== process.getuid()) {
		throw new Error(
			`${dirname(socketPath)} belongs to another user; not starting a server there.`,
		);
	}

	if (!existsSync(socketPath)) {
		return;
	}

	if (await isServing(socketPath)) {
		throw new Error(`A server is already running on ${socketPath}.`);
	}

	rmSync(socketPath, { force: true });
}

/**
 * Take the config's pid file, or fail when a live server holds it. One left
 * by a server that died is taken over.
 */
function acquirePidLock(pidPath: string): void {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(pidPath, String(process.pid), { flag: "wx", mode: 0o600 });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}

		const holder = readPid(pidPath);

		if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
			throw new Error(
				`A server for this config is already running (pid ${holder}).`,
			);
		}

		rmSync(pidPath, { force: true });
	}

	throw new Error(`Could not take ${pidPath}.`);
}

/** The pid in a server's pid file, if there is a readable one. */
export function readPid(pidPath: string): number | undefined {
	try {
		const pid = Number(readFileSync(pidPath, "utf8").trim());

		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a process is running (signal 0 only checks; Windows too). */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// It exists, but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function isServing(socketPath: string): Promise<boolean> {
	try {
		const response = await fetch("http://localhost/health", {
			unix: socketPath,
			signal: AbortSignal.timeout(1000),
		});

		return response.ok;
	} catch {
		return false;
	}
}
