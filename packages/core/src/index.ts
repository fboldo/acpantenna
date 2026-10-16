import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type AcpAttachment,
	type AcpClient,
	type AcpPromptResult,
	type AcpSessionResult,
	type AcpSessionUpdate,
	type CreateElicitationResponse,
	createTextPrompt,
	extractAuthMethodIds,
	isAuthRequiredError,
	parseSessionUpdate,
	type RequestPermissionResponse,
	StdioAcpClient,
} from "@acpantenna/acp";
import {
	attachmentNotice,
	type ChannelAcpClient,
	type ChannelAcpConnection,
	type ChannelAdapter,
	type ChannelElicitationField,
	type ChannelFactory,
	type ChannelInboundEvent,
	type ChannelInteractionOption,
	type ChannelInteractionResponse,
	type ChannelLogger,
	type ChannelOutboundEvent,
	type ChannelOutboundMessage,
	type ChannelPairing,
	type ChannelRouteHandler,
	type ChannelRouteRegistry,
	type ChannelToolCall,
	createConsoleLogger,
} from "@acpantenna/channel";
import type {
	AgentConfig,
	McpServerConfig,
	ResolvedAcpAntennaConfig,
	ResolvedChannelConfig,
	SessionPolicyConfig,
} from "@acpantenna/config";
import {
	type CorrelationContext,
	SPAN_NAMES,
	withSpan,
} from "@acpantenna/observability/instrument";
import { attachmentAsText, resolveAttachment } from "./attachments.ts";

export interface AcpAntennaGatewayOptions {
	config: ResolvedAcpAntennaConfig;
	channelFactories?: Record<string, ChannelFactory<unknown>>;
	acpClientFactory?: (agentId: string, agentConfig: AgentConfig) => AcpClient;
	/**
	 * An agent the config does not name, by id: how `connect` reaches a preset
	 * such as `claude`, and how a connection to one is re-attached after a
	 * restart.
	 */
	resolveAgent?: (agentId: string) => AgentConfig | undefined;
	logger?: ChannelLogger;
	/**
	 * A connection ended from its channel's side (a remote client left, a
	 * pairing expired), not through `disconnect`.
	 */
	onConnectionEnded?: (mapping: SessionMapping, reason: string) => void;
}

export interface SessionMapping {
	channelId: string;
	sessionKey: string;
	agentId: string;
	acpSessionId: string;
	conversationId: string;
	updatedAt: string;
	/** The directory the ACP session works in, when not the agent's own. */
	cwd?: string;
	/**
	 * Made by `connect`: the conversation stays with this agent and session,
	 * whatever agent the channel is configured with, until disconnected.
	 */
	connection?: boolean;
}

/** What `connect` binds: one conversation of a running channel to an agent session. */
export interface ConnectRequest {
	channelId: string;
	conversationId: string;
	agentId: string;
	/** An existing ACP session to resume; a new one is created when omitted. */
	acpSessionId?: string;
	/** Fork `acpSessionId` (`session/fork`) rather than resume it. */
	fork?: boolean;
	/** The session's working directory. Defaults to the agent's, else the gateway's. */
	cwd?: string;
}

/** Which connection to drop: by its ACP session, or by its conversation. */
export type DisconnectTarget =
	| { acpSessionId: string }
	| { channelId: string; conversationId: string };

/** A connection to a conversation, by channel and conversation id. */
export interface ConversationTarget {
	channelId: string;
	conversationId: string;
}

export type InboundEventStatus = "received" | "processing" | "done" | "failed";

/**
 * A durably-recorded inbound event. Persisted before the gateway acts on it, so
 * an interrupted turn can be recovered and re-processed after a restart.
 */
export interface InboundEventRecord {
	id: string;
	channelId: string;
	sessionKey: string;
	status: InboundEventStatus;
	event: ChannelInboundEvent;
	attempts: number;
	createdAt: string;
	updatedAt: string;
}

export interface StateStore {
	getSession(
		channelId: string,
		sessionKey: string,
	): Promise<SessionMapping | undefined>;
	findByAcpSessionId(acpSessionId: string): Promise<SessionMapping | undefined>;
	setSession(mapping: SessionMapping): Promise<void>;
	deleteSession(channelId: string, sessionKey: string): Promise<void>;
	listSessions(): Promise<SessionMapping[]>;
	saveEvent(record: InboundEventRecord): Promise<void>;
	setEventStatus(
		id: string,
		status: InboundEventStatus,
		attempts: number,
	): Promise<void>;
	deleteEvent(id: string): Promise<void>;
	listEvents(): Promise<InboundEventRecord[]>;
	close?(): Promise<void> | void;
}

interface AgentRuntime {
	client: AcpClient;
	initialized: boolean;
	initializing?: Promise<void>;
	/** ACP session ids known to be live in this agent process. */
	liveSessions: Set<string>;
	lastError?: string;
	/** Consecutive failed respawns, for backoff after the process exits. */
	respawnAttempts: number;
	respawnTimer?: ReturnType<typeof setTimeout>;
}

/** Who a new ACP session belongs to, and where it works. */
interface SessionTarget {
	agentId: string;
	agentConfig: AgentConfig;
	/** Overrides the agent's own directory. */
	cwd?: string;
}

interface ChannelRuntime {
	adapter: ChannelAdapter<unknown>;
	config: ResolvedChannelConfig;
}

/** A connection whose channel carries its ACP to a remote client. */
interface AcpConnection {
	client: ChannelAcpClient;
	/** The connection as it is now: `session/new` from the client rebinds it. */
	mapping: SessionMapping;
}

export type ChannelState = "starting" | "ready" | "failing";
export type AgentState = "idle" | "starting" | "up" | "down";

/** One channel's line in `GET /status`. */
export interface ChannelStatus {
	type: string;
	state: ChannelState;
	lastError?: string;
	lastErrorAt?: string;
}

/** One agent's line in `GET /status`. `idle` means not spawned yet (agents start on first use). */
export interface AgentStatus {
	state: AgentState;
	lastError?: string;
}

export interface GatewayStatus {
	ok: boolean;
	channels: Record<string, ChannelStatus>;
	agents: Record<string, AgentStatus>;
}

/**
 * Text or a thought the agent is still sending, coalesced into one outbound
 * message. `push` is reply text sent between turns.
 */
interface PendingSegment {
	kind: "push" | "thought";
	parts: string[];
	pushId?: string;
	origin: "turn" | "push";
	timer?: ReturnType<typeof setTimeout>;
}

/** A command core answers itself instead of prompting the agent. */
export type ReservedCommand =
	| { name: "cancel" }
	| { name: "new" }
	| { name: "mode"; modeId?: string };

interface RouteDefinition {
	method: string;
	path: string;
	handler: ChannelRouteHandler;
}

/** The turn was cancelled while an interaction waited (ACP's `cancelled` outcome). */
const CANCELLED = Symbol("cancelled");

type InteractionResult =
	| ChannelInteractionResponse
	| undefined
	| typeof CANCELLED;

interface PendingInteraction {
	resolve: (response: InteractionResult) => void;
	timer: ReturnType<typeof setTimeout>;
	acpSessionId: string;
}

interface PermissionOptionLike {
	optionId: string;
	name?: string;
	kind?: string;
}

type ElicitationField = ChannelElicitationField;

interface InteractionPrompt {
	kind: "permission" | "elicitation";
	message: string;
	options?: ChannelInteractionOption[];
	fields?: ElicitationField[];
	toolCall?: ChannelToolCall;
}

export class AcpAntennaGateway {
	private readonly config: ResolvedAcpAntennaConfig;
	private readonly channelFactories: Record<string, ChannelFactory<unknown>>;
	private readonly acpClientFactory?: (
		agentId: string,
		agentConfig: AgentConfig,
	) => AcpClient;
	private readonly resolveAgent?: (agentId: string) => AgentConfig | undefined;
	private readonly onConnectionEnded?: (
		mapping: SessionMapping,
		reason: string,
	) => void;
	/** Connections whose channel carries their ACP itself, by ACP session id. */
	private readonly acpConnections = new Map<string, AcpConnection>();
	/** Agents the config does not name, resolved once each through `resolveAgent`. */
	private readonly resolvedAgents = new Map<string, AgentConfig>();
	private readonly logger: ChannelLogger;
	private readonly channels = new Map<string, ChannelRuntime>();
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly routes: RouteDefinition[] = [];
	private readonly activeSessions = new Map<string, SessionMapping>();
	private promptQueue?: SerialQueue;
	private deliveryQueue?: SerialQueue;
	private readonly deliveryBuffers = new Map<string, string[]>();
	/**
	 * Files sent mid-turn to a channel that buffers the reply until the turn
	 * ends. They follow the reply rather than arriving before the words that
	 * introduce them.
	 */
	private readonly turnAttachments = new Map<string, AcpAttachment[]>();
	private readonly deliveryDebounceTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly pendingInteractions = new Map<string, PendingInteraction>();
	private readonly turnSenderTrusted = new Map<string, boolean>();
	/** ACP sessions with a `session/prompt` in flight, by ACP session id. */
	private readonly turnsInFlight = new Set<string>();
	/**
	 * ACP sessions being resumed or loaded. `session/load` replays the whole
	 * conversation as updates before it answers; those are history, not news.
	 */
	private readonly replaying = new Set<string>();
	/** Per ACP session, the tail of its update handling, so updates stay in order. */
	private readonly updateChains = new Map<string, Promise<void>>();
	private readonly segments = new Map<string, PendingSegment>();
	/** Tool calls seen per ACP session, so a bare status update keeps its title. */
	private readonly toolCalls = new Map<string, Map<string, ChannelToolCall>>();
	/** Modes the agent offered for each session it created. */
	private readonly sessionModes = new Map<string, string[]>();
	private readonly channelStatus = new Map<string, ChannelStatus>();
	private stateStore?: StateStore;
	private idleSweepTimer?: ReturnType<typeof setInterval>;
	private started = false;

	public constructor(options: AcpAntennaGatewayOptions) {
		this.config = options.config;
		this.channelFactories = options.channelFactories ?? {};
		this.acpClientFactory = options.acpClientFactory;
		this.resolveAgent = options.resolveAgent;
		this.onConnectionEnded = options.onConnectionEnded;
		this.logger = options.logger ?? createConsoleLogger("acpantenna");
	}

	public async start(): Promise<void> {
		if (this.started) {
			return;
		}

		this.stateStore = createStateStore(this.config);
		this.promptQueue = new SerialQueue("prompt");
		this.deliveryQueue = new SerialQueue("delivery");

		for (const [channelId, channelConfig] of Object.entries(
			this.config.channels,
		)) {
			const factory = this.channelFactories[channelConfig.type];

			if (!factory) {
				throw new Error(
					`No channel factory registered for type "${channelConfig.type}".`,
				);
			}

			const adapter = factory(channelConfig);
			const channelLogger = createConsoleLogger(`channel:${channelId}`);

			this.channelStatus.set(channelId, {
				type: channelConfig.type,
				state: "starting",
			});

			try {
				await adapter.start({
					channelId,
					config: channelConfig,
					stateDir: channelStateDir(this.config.state.path, channelId),
					logger: channelLogger,
					emit: async (event) => {
						await this.handleInboundEvent(channelId, event);
					},
				});
			} catch (error) {
				// One channel that cannot start (a bad token, a network outage) must
				// not take the others down; /status reports it instead.
				this.recordChannelError(channelId, error);
				this.logger.error("Channel failed to start.", {
					channelId,
					error: toMessage(error),
				});
				continue;
			}

			this.setChannelState(channelId, "ready");

			if (adapter.registerRoutes) {
				adapter.registerRoutes(
					new GatewayRouteRegistry(`/channels/${channelId}`, this.routes),
				);
			}

			this.channels.set(channelId, {
				adapter,
				config: channelConfig,
			});
		}

		await this.dropAcpConnections();
		this.startIdleSweep();
		this.started = true;
		// Rehydration is queued per session key ahead of recovered events, so a
		// replayed prompt finds its session already re-attached.
		await this.rehydrateSessions();
		await this.recoverPendingEvents();
	}

	/**
	 * Re-attach stored sessions used recently, so an agent that pushes between
	 * turns can reach conversations nobody has written in since the restart.
	 * Only `session/resume` or `session/load`: rehydration never creates a
	 * session, since a new one would have nothing to push about. Runs in the
	 * background through the prompt queue.
	 */
	private async rehydrateSessions(agentId?: string): Promise<void> {
		const now = Date.now();
		let count = 0;

		for (const mapping of await this.requireStateStore().listSessions()) {
			const channel = this.channels.get(mapping.channelId);
			const policy = channel?.config.session;

			// A connection lasts until it is dropped, however long it was quiet.
			if (
				!channel ||
				!policy?.rehydrateOnStart ||
				(!mapping.connection && mapping.agentId !== channel.config.agent) ||
				(agentId !== undefined && mapping.agentId !== agentId) ||
				(!mapping.connection &&
					!isWithinDays(mapping.updatedAt, policy.rehydrateWithinDays, now))
			) {
				continue;
			}

			count += 1;
			void this.requirePromptQueue()
				.enqueue(`${mapping.channelId}:${mapping.sessionKey}`, () =>
					this.rehydrateSession(mapping),
				)
				.catch(() => undefined);
		}

		if (count > 0) {
			this.logger.info("Rehydrating stored sessions.", { count });
		}
	}

	private async rehydrateSession(stored: SessionMapping): Promise<void> {
		// The mapping may have moved on (a /new, an idle sweep) while queued.
		const mapping = await this.requireStateStore().getSession(
			stored.channelId,
			stored.sessionKey,
		);
		const agentConfig = this.agentConfig(stored.agentId);

		if (
			!mapping ||
			mapping.acpSessionId !== stored.acpSessionId ||
			!agentConfig
		) {
			return;
		}

		let runtime: AgentRuntime;

		try {
			runtime = await this.ensureAgent(mapping.agentId, agentConfig);
		} catch (error) {
			this.logger.warn("Could not start the agent to rehydrate a session.", {
				agentId: mapping.agentId,
				error: toMessage(error),
			});
			return;
		}

		const live =
			runtime.liveSessions.has(mapping.acpSessionId) ||
			(await this.reattachSession(
				runtime,
				mapping,
				agentConfig,
				correlationFromMapping(mapping),
			));

		if (live) {
			this.activeSessions.set(mapping.acpSessionId, mapping);
		} else {
			this.logger.warn("Could not rehydrate a stored session.", {
				channelId: mapping.channelId,
				sessionKey: mapping.sessionKey,
				acpSessionId: mapping.acpSessionId,
			});
		}
	}

	private async recoverPendingEvents(): Promise<void> {
		const pending = (await this.requireStateStore().listEvents()).filter(
			(record) =>
				record.status === "received" || record.status === "processing",
		);

		for (const record of pending) {
			void this.enqueueProcessing(record);
		}

		if (pending.length > 0) {
			this.logger.info("Recovered pending inbound events.", {
				count: pending.length,
			});
		}
	}

	public async stop(): Promise<void> {
		this.started = false;

		for (const connection of [...this.acpConnections.values()]) {
			await this.closeAcpClient(connection, "The server stopped.");
		}

		if (this.idleSweepTimer) {
			clearInterval(this.idleSweepTimer);
			this.idleSweepTimer = undefined;
		}

		for (const channel of this.channels.values()) {
			await channel.adapter.stop?.();
		}

		await this.promptQueue?.close();
		await this.deliveryQueue?.close();

		for (const agent of this.agents.values()) {
			await agent.client.dispose();
		}

		this.promptQueue = undefined;
		this.deliveryQueue = undefined;
		this.deliveryBuffers.clear();

		for (const timer of this.deliveryDebounceTimers.values()) {
			clearTimeout(timer);
		}

		this.deliveryDebounceTimers.clear();

		for (const pending of this.pendingInteractions.values()) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
		}

		this.pendingInteractions.clear();
		this.turnSenderTrusted.clear();

		for (const segment of this.segments.values()) {
			if (segment.timer) {
				clearTimeout(segment.timer);
			}
		}

		this.segments.clear();

		for (const agent of this.agents.values()) {
			if (agent.respawnTimer) {
				clearTimeout(agent.respawnTimer);
			}
		}

		await this.stateStore?.close?.();
		this.started = false;
	}

	private clearDebounceTimer(acpSessionId: string): void {
		const timer = this.deliveryDebounceTimers.get(acpSessionId);

		if (timer) {
			clearTimeout(timer);
			this.deliveryDebounceTimers.delete(acpSessionId);
		}
	}

	private startIdleSweep(): void {
		const ttls = Object.values(this.config.channels)
			.map((channelConfig) => channelConfig.session.idleTtlSeconds)
			.filter((ttl): ttl is number => typeof ttl === "number" && ttl > 0);

		if (ttls.length === 0) {
			return;
		}

		// Sweep at half the shortest TTL (min 1s) so an expired session is
		// reclaimed within ~1.5x its TTL.
		const intervalMs = Math.max(
			1000,
			Math.floor((Math.min(...ttls) * 1000) / 2),
		);

		this.idleSweepTimer = setInterval(() => {
			void this.sweepIdleSessions();
		}, intervalMs);

		// Don't keep the process alive solely for the sweep.
		(this.idleSweepTimer as { unref?: () => void }).unref?.();
	}

	/**
	 * Close ACP sessions whose channel-configured idle TTL has elapsed since the
	 * last activity, and drop their runtime and persisted state. Public so it can
	 * be triggered deterministically (tests/ops); the start() timer also drives it.
	 */
	public async sweepIdleSessions(now = Date.now()): Promise<void> {
		const stateStore = this.requireStateStore();

		for (const mapping of await stateStore.listSessions()) {
			const ttlSeconds =
				this.config.channels[mapping.channelId]?.session.idleTtlSeconds;

			// A connection is dropped by `disconnect`, never for being quiet.
			if (
				mapping.connection ||
				!isMappingExpired(mapping.updatedAt, ttlSeconds, now)
			) {
				continue;
			}

			const runtime = this.agents.get(mapping.agentId);

			if (runtime) {
				await this.closeAcpSession(runtime, mapping.acpSessionId);
			} else {
				this.activeSessions.delete(mapping.acpSessionId);
			}

			await stateStore.deleteSession(mapping.channelId, mapping.sessionKey);
			this.logger.info("Closed idle ACP session.", {
				channelId: mapping.channelId,
				sessionKey: mapping.sessionKey,
				acpSessionId: mapping.acpSessionId,
			});
		}
	}

	private async closeAcpSession(
		runtime: AgentRuntime,
		acpSessionId: string,
	): Promise<void> {
		runtime.liveSessions.delete(acpSessionId);
		this.activeSessions.delete(acpSessionId);
		this.deliveryBuffers.delete(acpSessionId);
		this.turnAttachments.delete(acpSessionId);
		this.clearDebounceTimer(acpSessionId);
		this.dropSegment(acpSessionId);
		this.toolCalls.delete(acpSessionId);
		this.sessionModes.delete(acpSessionId);
		this.turnSenderTrusted.delete(acpSessionId);
		this.cancelPendingInteractions(acpSessionId);

		// session/close is only available when the agent advertises it; otherwise
		// dropping local state is all we can do.
		if (
			runtime.client.getAgentCapabilities?.()?.closeSession &&
			runtime.client.closeSession
		) {
			try {
				await runtime.client.closeSession(acpSessionId);
			} catch (error) {
				this.logger.warn("ACP session close failed.", {
					acpSessionId,
					error: toMessage(error),
				});
			}
		}
	}

	public readonly fetch = async (request: Request): Promise<Response> => {
		const requestUrl = new URL(request.url);
		const requestPath = normalizeRoutePath(requestUrl.pathname);

		if (requestPath === "/health" && request.method === "GET") {
			return Response.json({ ok: true, channels: [...this.channels.keys()] });
		}

		if (requestPath === "/status" && request.method === "GET") {
			return Response.json(await this.status());
		}

		const route = this.routes.find(
			(candidate) =>
				candidate.method === request.method.toUpperCase() &&
				candidate.path === requestPath,
		);

		if (!route) {
			return Response.json({ ok: false, error: "Not found" }, { status: 404 });
		}

		return await route.handler(request);
	};

	public async listSessions(): Promise<SessionMapping[]> {
		return await this.requireStateStore().listSessions();
	}

	/** Whether any running channel takes HTTP requests, so needs a port. */
	public hasRoutes(): boolean {
		return this.routes.length > 0;
	}

	public async listConnections(): Promise<SessionMapping[]> {
		return (await this.listSessions()).filter((mapping) => mapping.connection);
	}

	/**
	 * Bind a conversation to an agent session: an existing one, resumed (or
	 * forked), or a new one. From then on the conversation talks to that
	 * session, whatever agent its channel is configured with, until
	 * `disconnect`. A conversation holds one connection at a time.
	 */
	public async connect(request: ConnectRequest): Promise<SessionMapping> {
		const { channelId, conversationId, agentId } = request;
		const channel = this.channels.get(channelId);

		if (!channel) {
			throw new Error(
				channelId in this.config.channels
					? `Channel "${channelId}" is not running.`
					: `There is no channel "${channelId}".`,
			);
		}

		const agentConfig = this.agentConfig(agentId);

		if (!agentConfig) {
			throw new Error(`There is no agent "${agentId}".`);
		}

		if (request.fork && !request.acpSessionId) {
			throw new Error("Only an existing session can be forked.");
		}

		const sessionKey = conversationSessionKey(
			channelId,
			conversationId,
			channel.config.session,
		);

		if (!sessionKey) {
			throw new Error(
				`Channel "${channelId}" keys its sessions by sender, so a conversation cannot be connected.`,
			);
		}

		const cwd = resolve(request.cwd ?? agentConfig.cwd ?? process.cwd());
		const correlation: CorrelationContext = {
			channelId,
			conversationId,
			sessionKey,
			agentId,
		};

		return await this.requirePromptQueue().enqueue(
			`${channelId}:${sessionKey}`,
			async () => {
				const stateStore = this.requireStateStore();
				const existing = await stateStore.getSession(channelId, sessionKey);

				if (existing?.connection) {
					if (
						existing.agentId === agentId &&
						existing.acpSessionId === request.acpSessionId &&
						!request.fork
					) {
						return existing;
					}

					throw new Error(
						`Conversation "${conversationId}" is already connected to session ${existing.acpSessionId}. Disconnect it first.`,
					);
				}

				const runtime = await this.ensureAgent(agentId, agentConfig);
				const pending: SessionMapping = {
					channelId,
					sessionKey,
					agentId,
					acpSessionId: request.acpSessionId ?? "",
					conversationId,
					updatedAt: new Date().toISOString(),
					cwd,
					connection: true,
				};
				const acpSessionId = await this.openConnectedSession(
					runtime,
					pending,
					agentConfig,
					{ fork: request.fork ?? false, correlation },
				);
				const mapping: SessionMapping = { ...pending, acpSessionId };

				await stateStore.setSession(mapping);
				this.activeSessions.set(acpSessionId, mapping);

				if (carriesAcp(channel)) {
					try {
						await this.attachAcp(channel, mapping, agentConfig);
					} catch (error) {
						await this.closeAcpSession(runtime, acpSessionId);
						await stateStore.deleteSession(channelId, sessionKey);
						throw error;
					}
				}

				// The conversation's own session, if it had one, is replaced.
				if (existing && existing.acpSessionId !== acpSessionId) {
					const previous = this.agents.get(existing.agentId);

					if (previous) {
						await this.closeAcpSession(previous, existing.acpSessionId);
					} else {
						this.activeSessions.delete(existing.acpSessionId);
					}
				}

				this.logger.info("Connected a conversation to an agent session.", {
					channelId,
					conversationId,
					agentId,
					acpSessionId,
				});

				return mapping;
			},
		);
	}

	/**
	 * The session `connect` binds: forked from, or resumed as, the mapping's
	 * session; a new one when it names none.
	 */
	private async openConnectedSession(
		runtime: AgentRuntime,
		mapping: SessionMapping,
		agentConfig: AgentConfig,
		options: { fork: boolean; correlation: CorrelationContext },
	): Promise<string> {
		const { agentId, acpSessionId, cwd } = mapping;
		const { fork, correlation } = options;

		if (!acpSessionId) {
			return await this.createLiveSession(
				runtime,
				{ agentId, agentConfig, cwd },
				correlation,
			);
		}

		if (fork) {
			const client = runtime.client;

			if (!client.supportsForkSession?.() || !client.forkSession) {
				throw new Error(`Agent "${agentId}" cannot fork sessions.`);
			}

			const forked = await client.forkSession(acpSessionId, {
				cwd: resolve(cwd ?? agentConfig.cwd ?? process.cwd()),
				additionalDirectories: [],
				mcpServers: resolveMcpServers(this.config.mcpServers, agentConfig),
			});

			runtime.liveSessions.add(forked.sessionId);
			this.rememberModes(forked);

			return forked.sessionId;
		}

		if (runtime.liveSessions.has(acpSessionId)) {
			return acpSessionId;
		}

		const resumed = await this.reattachSession(
			runtime,
			mapping,
			agentConfig,
			correlation,
		);

		if (!resumed) {
			throw new Error(
				`Agent "${agentId}" could not resume session ${acpSessionId}.`,
			);
		}

		return acpSessionId;
	}

	/**
	 * Drop a connection: cancel its turn, close its ACP session and forget the
	 * binding. The agent keeps the session itself (a Claude transcript stays on
	 * disk). An agent the config does not name is stopped once nothing uses it.
	 * Resolves to the connection dropped, or undefined when there was none.
	 */
	public async disconnect(
		target: DisconnectTarget,
	): Promise<SessionMapping | undefined> {
		const stateStore = this.requireStateStore();
		let mapping: SessionMapping | undefined;

		if ("acpSessionId" in target) {
			mapping = await stateStore.findByAcpSessionId(target.acpSessionId);
		} else {
			const channel = this.config.channels[target.channelId];
			const sessionKey = channel
				? conversationSessionKey(
						target.channelId,
						target.conversationId,
						channel.session,
					)
				: undefined;

			mapping = sessionKey
				? await stateStore.getSession(target.channelId, sessionKey)
				: undefined;
		}

		if (!mapping?.connection) {
			return undefined;
		}

		const attached = this.acpConnections.get(mapping.acpSessionId);

		if (attached) {
			await this.closeAcpClient(attached, "Disconnected.");
		}

		const runtime = this.agents.get(mapping.agentId);

		if (runtime) {
			if (this.turnsInFlight.has(mapping.acpSessionId)) {
				this.cancelPendingInteractions(mapping.acpSessionId, CANCELLED);
				await runtime.client
					.cancel(mapping.acpSessionId)
					.catch(() => undefined);
			}

			await this.closeAcpSession(runtime, mapping.acpSessionId);
		} else {
			this.activeSessions.delete(mapping.acpSessionId);
		}

		await stateStore.deleteSession(mapping.channelId, mapping.sessionKey);
		this.logger.info("Disconnected a conversation from its agent session.", {
			channelId: mapping.channelId,
			conversationId: mapping.conversationId,
			agentId: mapping.agentId,
			acpSessionId: mapping.acpSessionId,
		});

		await this.stopUnusedAgent(mapping.agentId);

		return mapping;
	}

	/**
	 * Where pairing stands for a connection whose channel pairs with a
	 * remote client; undefined for any other.
	 */
	public pairing(target: ConversationTarget): ChannelPairing | undefined {
		return this.findAcpConnection(target)?.client.pairing?.();
	}

	/** The user's answer to a pairing's words. */
	public async confirmPairing(
		target: ConversationTarget,
		accepted: boolean,
	): Promise<void> {
		const client = this.findAcpConnection(target)?.client;

		if (!client?.confirmPairing) {
			throw new Error(
				`No pairing in conversation "${target.conversationId}" of channel "${target.channelId}".`,
			);
		}

		await client.confirmPairing(accepted);
	}

	/**
	 * Drops every connection on a channel that pairs, and has it forget its
	 * keys: no link it gave out works again. Resolves to the connections
	 * dropped.
	 */
	public async revoke(channelId: string): Promise<SessionMapping[]> {
		const channel = this.channels.get(channelId);

		if (!channel?.adapter.revoke) {
			throw new Error(`Channel "${channelId}" has nothing to revoke.`);
		}

		const dropped: SessionMapping[] = [];

		for (const mapping of await this.listConnections()) {
			if (mapping.channelId !== channelId) {
				continue;
			}

			const gone = await this.disconnect({
				channelId,
				conversationId: mapping.conversationId,
			});

			if (gone) {
				dropped.push(gone);
			}
		}

		await channel.adapter.revoke();
		this.logger.info("Revoked a channel's links.", {
			channelId,
			connections: dropped.length,
		});

		return dropped;
	}

	/** Whether a channel carries ACP to a remote client rather than chat. */
	public carriesAcp(channelId: string): boolean {
		const channel = this.channels.get(channelId);

		return channel ? carriesAcp(channel) : false;
	}

	private findAcpConnection(
		target: ConversationTarget,
	): AcpConnection | undefined {
		return [...this.acpConnections.values()].find(
			(connection) =>
				connection.mapping.channelId === target.channelId &&
				connection.mapping.conversationId === target.conversationId,
		);
	}

	/**
	 * Hands a new connection to its channel, which then speaks ACP to the
	 * agent for it: what the channel sends goes to the agent, and what the
	 * agent sends about the session goes to the channel instead of chat.
	 */
	private async attachAcp(
		channel: ChannelRuntime,
		mapping: SessionMapping,
		agentConfig: AgentConfig,
	): Promise<void> {
		const attach = channel.adapter.attachAcp;

		if (!attach) {
			throw new Error(`Channel "${mapping.channelId}" cannot carry ACP.`);
		}

		const { agentId } = mapping;
		const agent = async () => {
			const runtime = await this.ensureAgent(agentId, agentConfig);
			const { request, notify } = runtime.client;

			if (!request || !notify) {
				throw new Error(`Agent "${agentId}" cannot be proxied.`);
			}

			return {
				runtime,
				request: request.bind(runtime.client),
				notify: notify.bind(runtime.client),
			};
		};
		const agents = this.agents;
		const connection: AcpConnection = {
			client: undefined as unknown as ChannelAcpClient,
			mapping,
		};
		const handle: ChannelAcpConnection = {
			channelId: mapping.channelId,
			conversationId: mapping.conversationId,
			agentId,
			cwd: resolve(mapping.cwd ?? agentConfig.cwd ?? process.cwd()),
			get acpSessionId() {
				return connection.mapping.acpSessionId;
			},
			get initializeResult() {
				return agents.get(agentId)?.client.getInitializeResult?.();
			},
			mcpServers: resolveMcpServers(this.config.mcpServers, agentConfig),
			request: async (method, params) =>
				await (await agent()).request(method, params),
			notify: async (method, params) =>
				await (await agent()).notify(method, params),
			newSession: async () =>
				await this.rebindAcpConnection(connection, agentConfig),
			end: async (reason) => await this.endAcpConnection(connection, reason),
		};
		connection.client = await attach.call(channel.adapter, handle);
		this.acpConnections.set(mapping.acpSessionId, connection);
	}

	/** `session/new` from a remote client: a new session, in the connection's directory, and the old one closed. */
	private async rebindAcpConnection(
		connection: AcpConnection,
		agentConfig: AgentConfig,
	): Promise<Record<string, unknown>> {
		const previous = connection.mapping;
		const runtime = await this.ensureAgent(previous.agentId, agentConfig);
		const session = await this.createAcpSession(
			runtime.client,
			{ agentId: previous.agentId, agentConfig, cwd: previous.cwd },
			correlationFromMapping(previous),
		);
		const next: SessionMapping = {
			...previous,
			acpSessionId: session.sessionId,
			updatedAt: new Date().toISOString(),
		};

		runtime.liveSessions.add(session.sessionId);
		this.rememberModes(session);
		await this.requireStateStore().setSession(next);
		this.activeSessions.set(next.acpSessionId, next);
		this.acpConnections.delete(previous.acpSessionId);
		this.acpConnections.set(next.acpSessionId, connection);
		connection.mapping = next;
		await this.closeAcpSession(runtime, previous.acpSessionId);
		this.logger.info("A remote client started a new session.", {
			channelId: next.channelId,
			conversationId: next.conversationId,
			acpSessionId: next.acpSessionId,
		});

		return session as unknown as Record<string, unknown>;
	}

	/** The channel ended a connection: drop it as `disconnect` would. */
	private async endAcpConnection(
		connection: AcpConnection,
		reason: string,
	): Promise<void> {
		if (
			this.acpConnections.get(connection.mapping.acpSessionId) !== connection
		) {
			return;
		}

		const dropped = await this.disconnect({
			channelId: connection.mapping.channelId,
			conversationId: connection.mapping.conversationId,
		});

		if (dropped) {
			this.logger.info("A connection ended.", {
				channelId: dropped.channelId,
				conversationId: dropped.conversationId,
				reason,
			});
			this.onConnectionEnded?.(dropped, reason);
		}
	}

	private async closeAcpClient(
		connection: AcpConnection,
		reason: string,
	): Promise<void> {
		if (
			this.acpConnections.get(connection.mapping.acpSessionId) !== connection
		) {
			return;
		}

		this.acpConnections.delete(connection.mapping.acpSessionId);

		try {
			await connection.client.close(reason);
		} catch (error) {
			this.logger.warn("A channel failed to close a connection.", {
				channelId: connection.mapping.channelId,
				error: toMessage(error),
			});
		}
	}

	/**
	 * A remote client's pairing does not outlive the server that made it, so
	 * connections on such channels are forgotten when the gateway starts.
	 */
	private async dropAcpConnections(): Promise<void> {
		const stateStore = this.requireStateStore();

		for (const mapping of await stateStore.listSessions()) {
			const channel = this.channels.get(mapping.channelId);

			if (mapping.connection && channel && carriesAcp(channel)) {
				await stateStore.deleteSession(mapping.channelId, mapping.sessionKey);
				this.logger.info("Dropped a connection a restart cannot resume.", {
					channelId: mapping.channelId,
					conversationId: mapping.conversationId,
				});
			}
		}
	}

	/** Stop an agent the config does not name once no stored session uses it. */
	private async stopUnusedAgent(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);

		if (!runtime || agentId in this.config.agents) {
			return;
		}

		const inUse = (await this.requireStateStore().listSessions()).some(
			(mapping) => mapping.agentId === agentId,
		);

		if (inUse) {
			return;
		}

		if (runtime.respawnTimer) {
			clearTimeout(runtime.respawnTimer);
		}

		this.agents.delete(agentId);
		await runtime.client.dispose();
	}

	/** An agent by id: from the config, else from `resolveAgent`. */
	private agentConfig(agentId: string): AgentConfig | undefined {
		const configured = this.config.agents[agentId];

		if (configured) {
			return configured;
		}

		const known = this.resolvedAgents.get(agentId);

		if (known) {
			return known;
		}

		const resolved = this.resolveAgent?.(agentId);

		if (resolved) {
			this.resolvedAgents.set(agentId, resolved);
		}

		return resolved;
	}

	/**
	 * Each configured channel's state and each agent's, for a supervisor's
	 * settings page. A channel's own `health()` wins when it has one; otherwise
	 * the state is what starting it and sending through it last showed.
	 */
	public async status(): Promise<GatewayStatus> {
		const channels: Record<string, ChannelStatus> = {};

		for (const [channelId, channelConfig] of Object.entries(
			this.config.channels,
		)) {
			const known = this.channelStatus.get(channelId) ?? {
				type: channelConfig.type,
				state: "starting" as const,
			};
			const runtime = this.channels.get(channelId);
			let status: ChannelStatus = { ...known };

			if (runtime?.adapter.health) {
				try {
					const health = await runtime.adapter.health();
					const state: ChannelState =
						health.state === "ready"
							? "ready"
							: health.state === "starting"
								? "starting"
								: "failing";

					status = {
						...status,
						state:
							known.state === "failing" && state === "ready"
								? known.state
								: state,
						...(state === "failing" && health.message
							? { lastError: health.message, lastErrorAt: health.checkedAt }
							: {}),
					};
				} catch (error) {
					status = {
						...status,
						state: "failing",
						lastError: toMessage(error),
						lastErrorAt: new Date().toISOString(),
					};
				}
			}

			channels[channelId] = status;
		}

		const agents: Record<string, AgentStatus> = {};
		// Configured agents, and any other a connection started.
		const agentIds = new Set([
			...Object.keys(this.config.agents),
			...this.agents.keys(),
		]);

		for (const agentId of agentIds) {
			const runtime = this.agents.get(agentId);
			let state: AgentState = "idle";

			if (runtime?.initializing) {
				state = "starting";
			} else if (runtime?.initialized && runtime.client.isAlive?.() !== false) {
				state = "up";
			} else if (runtime) {
				state = "down";
			}

			agents[agentId] = {
				state,
				...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
			};
		}

		const ok =
			Object.values(channels).every((channel) => channel.state !== "failing") &&
			Object.values(agents).every((agent) => agent.state !== "down");

		return { ok, channels, agents };
	}

	private setChannelState(channelId: string, state: ChannelState): void {
		const current = this.channelStatus.get(channelId);

		if (current) {
			this.channelStatus.set(channelId, { ...current, state });
		}
	}

	private recordChannelError(channelId: string, error: unknown): void {
		const current = this.channelStatus.get(channelId);

		if (current) {
			this.channelStatus.set(channelId, {
				...current,
				state: "failing",
				lastError: toMessage(error),
				lastErrorAt: new Date().toISOString(),
			});
		}
	}

	public async listEvents(): Promise<InboundEventRecord[]> {
		return await this.requireStateStore().listEvents();
	}

	/** Wait for all queued prompt and delivery work to settle. */
	public async drain(): Promise<void> {
		await this.promptQueue?.idle();
		await this.deliveryQueue?.idle();
	}

	private async handleInboundEvent(
		channelId: string,
		event: ChannelInboundEvent,
	): Promise<void> {
		const channel = this.channels.get(channelId);

		if (!channel) {
			throw new Error(`Channel "${channelId}" is not started.`);
		}

		if (!isEventAllowed(channel.config, event)) {
			this.logger.warn("Rejected inbound event by channel policy.", {
				channelId,
				senderId: event.sender.id,
				conversationId: event.conversation.id,
			});
			return;
		}

		// An interaction response answers a pending prompt (a permission request
		// or elicitation); it is a control signal, not a new turn to process.
		if (event.interaction) {
			this.resolvePendingInteraction(event.interaction);
			return;
		}

		const sessionKey = resolveSessionKey(
			channelId,
			event,
			channel.config.session,
		);
		const command = parseReservedCommand(event.content.text);

		if (command) {
			const handling = this.handleReservedCommand({
				channelId,
				channel,
				event,
				sessionKey,
				command,
			});

			if (channel.config.intake.mode === "ackFast") {
				void handling.catch(() => undefined);
				return;
			}

			await handling;
			return;
		}
		const now = new Date().toISOString();
		const record: InboundEventRecord = {
			id: event.id,
			channelId,
			sessionKey,
			status: "received",
			event,
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		};

		// Persist before acting so an interrupted turn can be recovered.
		await this.requireStateStore().saveEvent(record);

		const processing = this.enqueueProcessing(record);

		// ackFast returns as soon as the event is durably received; the turn is
		// processed asynchronously. awaitTurn holds until processing completes.
		if (channel.config.intake.mode === "ackFast") {
			void processing;
			return;
		}

		await processing;
	}

	private enqueueProcessing(record: InboundEventRecord): Promise<void> {
		return this.requirePromptQueue().enqueue(
			`${record.channelId}:${record.sessionKey}`,
			() => this.processInboundEvent(record),
		);
	}

	private async processInboundEvent(record: InboundEventRecord): Promise<void> {
		const stateStore = this.requireStateStore();
		const channel = this.channels.get(record.channelId);
		const agentId = channel
			? await this.conversationAgent(
					record.channelId,
					record.sessionKey,
					channel.config,
				)
			: undefined;
		const agentConfig = agentId ? this.agentConfig(agentId) : undefined;
		const attempts = record.attempts + 1;

		if (!channel || !agentId || !agentConfig) {
			await stateStore.setEventStatus(record.id, "failed", attempts);
			this.logger.warn("Dropping inbound event: channel or agent not found.", {
				eventId: record.id,
				channelId: record.channelId,
			});
			return;
		}

		try {
			await stateStore.setEventStatus(record.id, "processing", attempts);
			await this.handleQueuedInboundEvent({
				channelId: record.channelId,
				event: record.event,
				agentId,
				agentConfig,
				sessionKey: record.sessionKey,
			});
			await stateStore.deleteEvent(record.id);
		} catch (error) {
			await stateStore.setEventStatus(record.id, "failed", attempts);
			this.logger.error("Inbound event processing failed.", {
				eventId: record.id,
				error: toMessage(error),
			});
			await this.deliverProcessingError(record, error);
		}
	}

	private async deliverProcessingError(
		record: InboundEventRecord,
		error: unknown,
	): Promise<void> {
		const channel = this.channels.get(record.channelId);

		if (!channel) {
			return;
		}

		const conversationId = record.event.conversation.id;

		await this.requireDeliveryQueue().enqueue(
			`${record.channelId}:${conversationId}`,
			() =>
				this.sendWithRetry(
					channel,
					{
						id: `${record.id}:error`,
						conversationId,
						text: `⚠️ ${toMessage(error)}`,
					},
					{
						channelId: record.channelId,
						conversationId,
						sessionKey: record.sessionKey,
					},
				),
		);
	}

	/**
	 * Decide an agent's `session/request_permission` by channel policy:
	 * `deny` (default) selects a reject option, `allowTrusted` allows when the
	 * turn's sender is trusted, and `ask` prompts the channel and awaits a reply.
	 * Falls back to `cancelled` when no suitable option or channel is available.
	 */
	private async handlePermissionRequest(
		params: unknown,
	): Promise<RequestPermissionResponse> {
		const sessionId = getAcpSessionId(params);
		const options = parsePermissionOptions(params);
		const attached = sessionId ? this.acpConnections.get(sessionId) : undefined;

		if (attached) {
			try {
				return (await attached.client.request(
					"session/request_permission",
					params,
				)) as RequestPermissionResponse;
			} catch (error) {
				this.logger.warn("A channel failed to answer a permission request.", {
					acpSessionId: sessionId,
					error: toMessage(error),
				});
				return permissionResponse(selectPermissionOptionId(options, "reject"));
			}
		}

		// Out of turn too: the agent may ask between turns (a question pushed
		// from elsewhere), and the owning conversation answers it all the same.
		const mapping = sessionId
			? await this.resolveMapping(sessionId)
			: undefined;
		const channel = mapping ? this.channels.get(mapping.channelId) : undefined;
		const policy = channel?.config.permissions.toolCalls ?? "deny";

		if (policy === "allowTrusted") {
			// Trust belongs to the sender of the turn in flight. Between turns
			// nobody is asking, so nobody's trust applies.
			const trusted =
				sessionId && this.turnsInFlight.has(sessionId)
					? (this.turnSenderTrusted.get(sessionId) ?? false)
					: false;

			return permissionResponse(
				selectPermissionOptionId(options, trusted ? "allow" : "reject"),
			);
		}

		if (policy === "ask" && mapping && channel) {
			return await this.askPermission(
				mapping,
				channel,
				options,
				parsePermissionToolCall(params),
			);
		}

		return permissionResponse(selectPermissionOptionId(options, "reject"));
	}

	/**
	 * Bridges an ACP elicitation request to the originating channel as an
	 * interactive form, then maps the user's answer back to the agent.
	 *
	 * Only session-scoped, form-mode elicitation can be routed to a channel. URL
	 * mode, request-scoped elicitation (no session yet), and requests without a
	 * live channel are declined.
	 */
	private async handleElicitationRequest(
		params: unknown,
	): Promise<CreateElicitationResponse> {
		const sessionId = getAcpSessionId(params);
		const attached = sessionId ? this.acpConnections.get(sessionId) : undefined;

		if (attached) {
			try {
				return (await attached.client.request(
					"elicitation/create",
					params,
				)) as CreateElicitationResponse;
			} catch (error) {
				this.logger.warn("A channel failed to answer an elicitation.", {
					acpSessionId: sessionId,
					error: toMessage(error),
				});
				return { action: "decline" };
			}
		}

		const mapping = sessionId
			? await this.resolveMapping(sessionId)
			: undefined;
		const channel = mapping ? this.channels.get(mapping.channelId) : undefined;
		const elicitation = parseElicitation(params);

		if (!mapping || !channel || !elicitation || elicitation.mode !== "form") {
			return { action: "decline" };
		}

		const choiceField = singleChoiceField(elicitation.fields);
		const response = await this.awaitInteraction(mapping, channel, {
			kind: "elicitation",
			message: elicitation.message,
			fields: elicitation.fields,
			...(choiceField ? { options: choiceOptions(choiceField) } : {}),
		});

		if (response === CANCELLED) {
			return { action: "cancel" };
		}

		if (!response || response.declined) {
			return { action: "decline" };
		}

		// A clicked choice fills the form's one enum field, with the value's
		// own type; anything not offered is refused.
		if (!response.content && response.optionId !== undefined && choiceField) {
			const value = choiceField.enum?.find(
				(candidate) => String(candidate) === response.optionId,
			);

			return value === undefined
				? { action: "decline" }
				: { action: "accept", content: { [choiceField.name]: value } };
		}

		// Timed out or explicitly declined.
		if (!response.content) {
			return { action: "decline" };
		}

		return { action: "accept", content: response.content };
	}

	private async askPermission(
		mapping: SessionMapping,
		channel: ChannelRuntime,
		options: PermissionOptionLike[],
		toolCall: ChannelToolCall | undefined,
	): Promise<RequestPermissionResponse> {
		const response = await this.awaitInteraction(mapping, channel, {
			kind: "permission",
			message: toolCall?.title ?? "The agent is requesting permission.",
			options: options.map((option) => ({
				id: option.optionId,
				label: option.name ?? option.optionId,
				kind: option.kind?.startsWith("allow") ? "allow" : "reject",
			})),
			...(toolCall ? { toolCall } : {}),
		});

		// A cancelled turn answers its pending permissions `cancelled` (ACP spec).
		if (response === CANCELLED) {
			return permissionResponse(undefined);
		}

		// Timed out or explicitly declined → deny.
		if (!response || response.declined) {
			return permissionResponse(selectPermissionOptionId(options, "reject"));
		}

		// Only honour an option the agent actually offered.
		const chosen = options.find(
			(option) => option.optionId === response.optionId,
		);

		return permissionResponse(chosen?.optionId);
	}

	/**
	 * Presents an interaction (permission or elicitation) on the channel and
	 * awaits the user's response. Resolves to `undefined` on timeout so the
	 * caller can apply its own safe default (deny/decline).
	 */
	private async awaitInteraction(
		mapping: SessionMapping,
		channel: ChannelRuntime,
		prompt: InteractionPrompt,
	): Promise<InteractionResult> {
		const interactionId = crypto.randomUUID();
		const timeoutMs =
			channel.config.permissions.interactionTimeoutSeconds * 1000;

		// Whatever the agent said before asking goes out first, so the question
		// is read with its context.
		await this.settleUpdates(mapping.acpSessionId);
		await this.flushSegment(mapping);

		return await new Promise<InteractionResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingInteractions.delete(interactionId);
				resolve(undefined);
			}, timeoutMs);

			(timer as { unref?: () => void }).unref?.();
			this.pendingInteractions.set(interactionId, {
				resolve,
				timer,
				acpSessionId: mapping.acpSessionId,
			});

			void this.presentInteraction(mapping, interactionId, prompt);
		});
	}

	private async presentInteraction(
		mapping: SessionMapping,
		interactionId: string,
		prompt: InteractionPrompt,
	): Promise<void> {
		const channel = this.channels.get(mapping.channelId);

		if (!channel) {
			return;
		}

		const buttons = channel.adapter.manifest.capabilities?.buttons === true;
		// A channel with buttons renders the options itself; the others get the
		// choices spelled out in the text, as before.
		const text = buttons
			? `${prompt.kind === "permission" ? "🔒" : "📝"} ${prompt.message}`
			: prompt.kind === "permission"
				? `🔒 ${prompt.message} Reply to interaction ${interactionId} with one of: ${(
						prompt.options ?? []
					)
						.map((option) => `${option.id} (${option.label})`)
						.join(", ")}`
				: `📝 ${prompt.message} Reply to interaction ${interactionId} with: ${(
						prompt.fields ?? []
					)
						.map(describeFieldForText)
						.join(", ")}`;

		await this.requireDeliveryQueue().enqueue(
			`${mapping.channelId}:${mapping.conversationId}`,
			() =>
				this.sendWithRetry(
					channel,
					{
						id: `${interactionId}:prompt`,
						conversationId: mapping.conversationId,
						text,
						origin: this.turnsInFlight.has(mapping.acpSessionId)
							? "turn"
							: "push",
						interaction: {
							id: interactionId,
							kind: prompt.kind,
							message: prompt.message,
							...(prompt.options && buttons ? { options: prompt.options } : {}),
							...(prompt.fields ? { fields: prompt.fields } : {}),
							...(prompt.toolCall ? { toolCall: prompt.toolCall } : {}),
						},
					},
					correlationFromMapping(mapping),
				),
		);
	}

	private resolvePendingInteraction(
		response: ChannelInteractionResponse,
	): void {
		const pending = this.pendingInteractions.get(response.id);

		if (!pending) {
			return;
		}

		clearTimeout(pending.timer);
		this.pendingInteractions.delete(response.id);
		pending.resolve(response);
	}

	private cancelPendingInteractions(
		acpSessionId: string,
		result: undefined | typeof CANCELLED = undefined,
	): void {
		for (const [id, pending] of this.pendingInteractions) {
			if (pending.acpSessionId === acpSessionId) {
				clearTimeout(pending.timer);
				this.pendingInteractions.delete(id);
				pending.resolve(result);
			}
		}
	}

	/** The conversation that owns an ACP session, live or only stored. */
	private async resolveMapping(
		acpSessionId: string,
	): Promise<SessionMapping | undefined> {
		const active = this.activeSessions.get(acpSessionId);

		if (active) {
			return active;
		}

		const stored =
			await this.requireStateStore().findByAcpSessionId(acpSessionId);

		if (stored) {
			this.activeSessions.set(acpSessionId, stored);
		}

		return stored;
	}

	private async handleQueuedInboundEvent(input: {
		channelId: string;
		event: ChannelInboundEvent;
		agentId: string;
		agentConfig: AgentConfig;
		sessionKey: string;
	}): Promise<void> {
		const { channelId, event, agentId, agentConfig, sessionKey } = input;
		const correlation: CorrelationContext = {
			channelId,
			conversationId: event.conversation.id,
			sessionKey,
			agentId,
		};
		const { runtime, mapping } = await this.acquireSession({
			channelId,
			sessionKey,
			conversationId: event.conversation.id,
			agentId,
			agentConfig,
			correlation,
		});
		const acpSessionId = mapping.acpSessionId;

		// The event id is stable across a recovery replay, so using it as the
		// prompt cycle id makes outbound idempotency ids replay-safe.
		correlation.promptCycleId = event.id;

		// Remember whether this turn's sender is trusted, for the `allowTrusted`
		// permission policy when the agent requests a tool permission mid-turn.
		this.turnSenderTrusted.set(acpSessionId, event.sender.trusted ?? false);

		// Anything the agent pushed before this turn is its own message, not the
		// start of this reply.
		await this.settleUpdates(acpSessionId);
		await this.flushSegment(mapping);
		this.turnAttachments.delete(acpSessionId);
		this.turnsInFlight.add(acpSessionId);

		let result: AcpPromptResult;

		try {
			result = await withSpan(
				{ name: SPAN_NAMES.promptTurn, correlation },
				async (span) => {
					// The turn ends the moment the response arrives; anything the
					// agent sends after it is a push.
					const promptResult = await runtime.client
						.prompt({
							sessionId: acpSessionId,
							prompt: createTextPrompt(
								event.content.text ?? serializeEventContent(event),
							),
						})
						.finally(() => {
							this.turnsInFlight.delete(acpSessionId);
						});

					span.setAttribute("acp.stop_reason", promptResult.stopReason);

					return promptResult;
				},
			);
		} finally {
			this.turnsInFlight.delete(acpSessionId);
			await this.settleUpdates(acpSessionId);
		}

		await this.flushSegment(mapping);
		await this.flushDelivery(mapping, correlation.promptCycleId);
		await this.flushTurnAttachments(mapping);
		await this.deliverStopReasonNotice(
			mapping,
			result.stopReason,
			correlation.promptCycleId,
		);
	}

	/**
	 * The live ACP session for a conversation: re-attached through the
	 * reconnect ladder, or created when there is none. Persists the mapping.
	 */
	private async acquireSession(input: {
		channelId: string;
		sessionKey: string;
		conversationId: string;
		agentId: string;
		agentConfig: AgentConfig;
		correlation: CorrelationContext;
	}): Promise<{ runtime: AgentRuntime; mapping: SessionMapping }> {
		const { channelId, sessionKey, agentId, agentConfig, correlation } = input;
		const runtime = await this.ensureAgent(agentId, agentConfig);
		const stateStore = this.requireStateStore();
		const existing = await stateStore.getSession(channelId, sessionKey);

		const acpSessionId = existing
			? await this.ensureLiveSession(
					runtime,
					existing,
					agentConfig,
					correlation,
				)
			: await this.createLiveSession(
					runtime,
					{ agentId, agentConfig },
					correlation,
				);

		if (existing && existing.acpSessionId !== acpSessionId) {
			this.activeSessions.delete(existing.acpSessionId);
		}

		correlation.acpSessionId = acpSessionId;

		const mapping: SessionMapping = {
			channelId,
			sessionKey,
			agentId,
			acpSessionId,
			conversationId: input.conversationId,
			updatedAt: new Date().toISOString(),
			...connectionFields(existing),
		};

		await stateStore.setSession(mapping);
		this.activeSessions.set(mapping.acpSessionId, mapping);

		return { runtime, mapping };
	}

	/**
	 * The agent a conversation talks to: the one it is connected to, else the
	 * channel's.
	 */
	private async conversationAgent(
		channelId: string,
		sessionKey: string,
		channelConfig: ResolvedChannelConfig,
	): Promise<string> {
		const stored = await this.requireStateStore().getSession(
			channelId,
			sessionKey,
		);

		return stored?.connection ? stored.agentId : channelConfig.agent;
	}

	/**
	 * `/cancel`, `/new` and `/mode <id>`: answered by core for every channel,
	 * never forwarded to the agent as a prompt.
	 */
	private async handleReservedCommand(input: {
		channelId: string;
		channel: ChannelRuntime;
		event: ChannelInboundEvent;
		sessionKey: string;
		command: ReservedCommand;
	}): Promise<void> {
		const { channelId, channel, event, sessionKey, command } = input;
		const conversationId = event.conversation.id;
		const stored = await this.requireStateStore().getSession(
			channelId,
			sessionKey,
		);
		const agentId = stored?.connection ? stored.agentId : channel.config.agent;
		const agentConfig = this.agentConfig(agentId);
		const correlation: CorrelationContext = {
			channelId,
			conversationId,
			sessionKey,
			agentId,
		};
		const reply = (text: string) =>
			this.requireDeliveryQueue().enqueue(
				`${channelId}:${conversationId}`,
				() =>
					this.sendWithRetry(
						channel,
						{
							id: `${event.id}:command`,
							conversationId,
							inReplyTo: event.id,
							text,
						},
						correlation,
					),
			);
		const inTurn = stored ? this.turnsInFlight.has(stored.acpSessionId) : false;

		if (!agentConfig) {
			await reply(`⚠️ Agent "${agentId}" is not configured.`);
			return;
		}

		switch (command.name) {
			case "cancel": {
				const runtime = stored ? this.agents.get(stored.agentId) : undefined;

				if (!stored || !runtime || !inTurn) {
					await reply("Nothing to cancel.");
					return;
				}

				this.cancelPendingInteractions(stored.acpSessionId, CANCELLED);
				await runtime.client.cancel(stored.acpSessionId);
				await reply("Cancelled the current turn.");
				return;
			}

			case "new": {
				// Queued behind any running turn for this conversation, so the
				// old session finishes what it was doing before it is dropped.
				await this.requirePromptQueue().enqueue(
					`${channelId}:${sessionKey}`,
					async () => {
						try {
							const runtime = await this.ensureAgent(agentId, agentConfig);
							const current = await this.requireStateStore().getSession(
								channelId,
								sessionKey,
							);
							// A connected conversation stays connected, in the same directory.
							const kept = connectionFields(current);
							const acpSessionId = await this.createLiveSession(
								runtime,
								{ agentId, agentConfig, cwd: kept.cwd },
								correlation,
							);
							const mapping: SessionMapping = {
								channelId,
								sessionKey,
								agentId,
								acpSessionId,
								conversationId,
								updatedAt: new Date().toISOString(),
								...kept,
							};

							await this.requireStateStore().setSession(mapping);
							this.activeSessions.set(acpSessionId, mapping);

							if (current && current.acpSessionId !== acpSessionId) {
								const previous = this.agents.get(current.agentId);

								if (previous) {
									await this.closeAcpSession(previous, current.acpSessionId);
								} else {
									this.activeSessions.delete(current.acpSessionId);
								}
							}

							await reply("Started a new session.");
						} catch (error) {
							await reply(
								`⚠️ Could not start a new session: ${toMessage(error)}`,
							);
						}
					},
				);
				return;
			}

			case "mode": {
				if (!command.modeId) {
					const modes = stored
						? this.sessionModes.get(stored.acpSessionId)
						: undefined;

					await reply(
						modes?.length
							? `Usage: /mode <id>. Modes: ${modes.join(", ")}.`
							: "Usage: /mode <id>.",
					);
					return;
				}

				const modeId = command.modeId;
				const setMode = async (runtime: AgentRuntime, acpSessionId: string) => {
					if (!runtime.client.setSessionMode) {
						await reply("⚠️ This agent does not support modes.");
						return;
					}

					try {
						await runtime.client.setSessionMode(acpSessionId, modeId);
						await reply(`Mode set to ${modeId}.`);
					} catch (error) {
						await reply(`⚠️ Could not set mode ${modeId}: ${toMessage(error)}`);
					}
				};

				// Mid-turn the session is live and switching is allowed (it may be
				// what unblocks a pending permission), so do not queue behind it.
				const runtime = stored ? this.agents.get(stored.agentId) : undefined;

				if (stored && runtime && inTurn) {
					await setMode(runtime, stored.acpSessionId);
					return;
				}

				await this.requirePromptQueue().enqueue(
					`${channelId}:${sessionKey}`,
					async () => {
						try {
							const acquired = await this.acquireSession({
								channelId,
								sessionKey,
								conversationId,
								agentId,
								agentConfig,
								correlation,
							});

							await setMode(acquired.runtime, acquired.mapping.acpSessionId);
						} catch (error) {
							await reply(
								`⚠️ Could not set mode ${modeId}: ${toMessage(error)}`,
							);
						}
					},
				);
				return;
			}
		}
	}

	private async deliverStopReasonNotice(
		mapping: SessionMapping,
		stopReason: string,
		promptCycleId: string | undefined,
	): Promise<void> {
		const notice = stopReasonNotice(stopReason);

		if (!notice) {
			return;
		}

		await this.enqueueDelivery(mapping, {
			id: deliveryId(promptCycleId, "notice"),
			conversationId: mapping.conversationId,
			origin: "turn",
			text: notice,
		});
	}

	private async ensureAgent(
		agentId: string,
		agentConfig: AgentConfig,
	): Promise<AgentRuntime> {
		const existingRuntime = this.agents.get(agentId);

		// A process that died (the agent crashed, or lost a daemon it fronts) is
		// started again; the sessions it held are re-attached on demand.
		if (
			existingRuntime?.initialized &&
			existingRuntime.client.isAlive?.() === false
		) {
			this.markAgentDown(existingRuntime);
		}

		if (existingRuntime?.initialized) {
			return existingRuntime;
		}

		const runtime: AgentRuntime = existingRuntime ?? {
			client: this.createAcpClient(agentId, agentConfig),
			initialized: false,
			liveSessions: new Set<string>(),
			respawnAttempts: 0,
		};

		if (!existingRuntime) {
			runtime.client.onSessionUpdate((params) =>
				this.handleAcpSessionUpdate(params),
			);
			runtime.client.onPermissionRequest?.((params) =>
				this.handlePermissionRequest(params),
			);
			runtime.client.onElicitation?.((params) =>
				this.handleElicitationRequest(params),
			);
			runtime.client.onExit?.(() => {
				this.handleAgentExit(agentId, runtime);
			});
			this.agents.set(agentId, runtime);
		}

		runtime.initializing ??= (async () => {
			await runtime.client.connect();
			await withSpan(
				{ name: SPAN_NAMES.initialize, correlation: { agentId } },
				() => runtime.client.initialize(),
			);
			await this.authenticateAgent(agentId, agentConfig, runtime.client);
			runtime.initialized = true;
		})();

		try {
			await runtime.initializing;
		} catch (error) {
			runtime.lastError = toMessage(error);
			throw error;
		} finally {
			runtime.initializing = undefined;
		}

		runtime.initialized = true;
		runtime.lastError = undefined;
		runtime.respawnAttempts = 0;

		return runtime;
	}

	private markAgentDown(runtime: AgentRuntime): void {
		runtime.initialized = false;

		for (const acpSessionId of runtime.liveSessions) {
			this.cancelPendingInteractions(acpSessionId, CANCELLED);
		}

		runtime.liveSessions.clear();
	}

	/**
	 * The agent process exited on its own. Its sessions are gone from memory
	 * until re-attached, so when any of its conversations rehydrate on start,
	 * respawn it (with backoff) and rehydrate them: pushes would otherwise stop
	 * until somebody happened to write.
	 */
	private handleAgentExit(agentId: string, runtime: AgentRuntime): void {
		runtime.lastError = "Agent process exited.";
		this.markAgentDown(runtime);
		this.logger.warn("ACP agent process exited.", { agentId });

		const wantsPushes =
			Object.values(this.config.channels).some(
				(channel) =>
					channel.agent === agentId && channel.session.rehydrateOnStart,
			) ||
			[...this.activeSessions.values()].some(
				(mapping) =>
					mapping.connection &&
					mapping.agentId === agentId &&
					this.config.channels[mapping.channelId]?.session.rehydrateOnStart,
			);

		if (this.started && wantsPushes) {
			this.scheduleRespawn(agentId, runtime);
		}
	}

	private scheduleRespawn(agentId: string, runtime: AgentRuntime): void {
		if (runtime.respawnTimer) {
			return;
		}

		const delayMs = Math.min(60_000, 1000 * 2 ** runtime.respawnAttempts);

		runtime.respawnTimer = setTimeout(() => {
			runtime.respawnTimer = undefined;
			void this.respawnAgent(agentId, runtime);
		}, delayMs);
		(runtime.respawnTimer as { unref?: () => void }).unref?.();
	}

	private async respawnAgent(
		agentId: string,
		runtime: AgentRuntime,
	): Promise<void> {
		const agentConfig = this.agentConfig(agentId);

		if (!this.started || !agentConfig || runtime.initialized) {
			return;
		}

		try {
			await this.ensureAgent(agentId, agentConfig);
		} catch (error) {
			runtime.respawnAttempts += 1;
			this.logger.warn("ACP agent respawn failed; retrying.", {
				agentId,
				attempt: runtime.respawnAttempts,
				error: toMessage(error),
			});
			this.scheduleRespawn(agentId, runtime);
			return;
		}

		await this.rehydrateSessions(agentId);
	}

	private async authenticateAgent(
		agentId: string,
		agentConfig: AgentConfig,
		client: AcpClient,
	): Promise<void> {
		const methodId = agentConfig.auth?.methodId;

		if (!methodId) {
			return;
		}

		const available = extractAuthMethodIds(client.getAuthMethods?.() ?? []);

		if (!available.includes(methodId)) {
			throw new Error(
				`Agent "${agentId}" does not advertise auth method "${methodId}". Available: ${available.join(", ") || "none"}.`,
			);
		}

		await client.authenticate(methodId);
	}

	private async createAcpSession(
		client: AcpClient,
		target: SessionTarget,
		correlation: CorrelationContext,
	): Promise<AcpSessionResult> {
		const { agentId, agentConfig, cwd } = target;

		try {
			return await withSpan({ name: SPAN_NAMES.sessionNew, correlation }, () =>
				client.newSession({
					cwd: resolve(cwd ?? agentConfig.cwd ?? process.cwd()),
					additionalDirectories: [],
					mcpServers: resolveMcpServers(this.config.mcpServers, agentConfig),
				}),
			);
		} catch (error) {
			if (isAuthRequiredError(error) && !agentConfig.auth?.methodId) {
				const available = extractAuthMethodIds(client.getAuthMethods?.() ?? []);

				throw new Error(
					`Agent "${agentId}" requires authentication. Set agents.${agentId}.auth.methodId in your config (available: ${available.join(", ") || "none"}).`,
				);
			}

			throw error;
		}
	}

	private async createLiveSession(
		runtime: AgentRuntime,
		target: SessionTarget,
		correlation: CorrelationContext,
	): Promise<string> {
		const session = await this.createAcpSession(
			runtime.client,
			target,
			correlation,
		);

		runtime.liveSessions.add(session.sessionId);
		this.rememberModes(session);

		return session.sessionId;
	}

	private rememberModes(session: AcpSessionResult): void {
		const modes = session.modes?.availableModes?.map((mode) => mode.id);

		if (modes?.length) {
			this.sessionModes.set(session.sessionId, modes);
		}
	}

	/**
	 * Re-attach to a persisted session, or create a fresh one. A persisted
	 * `acpSessionId` only means something to the agent process that created it; a
	 * new agent process (e.g. after a restart) has never heard of it. Following
	 * `openclaw/acpx`, reconnect with a capability-gated ladder:
	 * reuse-if-live -> `session/resume` -> `session/load` -> `session/new`.
	 */
	private async ensureLiveSession(
		runtime: AgentRuntime,
		mapping: SessionMapping,
		agentConfig: AgentConfig,
		correlation: CorrelationContext,
	): Promise<string> {
		if (runtime.liveSessions.has(mapping.acpSessionId)) {
			return mapping.acpSessionId;
		}

		if (
			await this.reattachSession(runtime, mapping, agentConfig, correlation)
		) {
			return mapping.acpSessionId;
		}

		return await this.createLiveSession(
			runtime,
			{ agentId: mapping.agentId, agentConfig, cwd: mapping.cwd },
			correlation,
		);
	}

	/**
	 * The resume -> load rungs of the reconnect ladder, without the fallback to
	 * a new session. Updates the agent sends meanwhile are dropped: a load
	 * replays the whole conversation, which the channel has already shown.
	 */
	private async reattachSession(
		runtime: AgentRuntime,
		mapping: SessionMapping,
		agentConfig: AgentConfig,
		correlation: CorrelationContext,
	): Promise<boolean> {
		const agentId = mapping.agentId;
		const request = {
			cwd: resolve(mapping.cwd ?? agentConfig.cwd ?? process.cwd()),
			additionalDirectories: [],
			mcpServers: resolveMcpServers(this.config.mcpServers, agentConfig),
		};
		const client = runtime.client;
		const sessionCorrelation: CorrelationContext = {
			...correlation,
			acpSessionId: mapping.acpSessionId,
		};
		const rungs: Array<{
			name: string;
			span: string;
			supported: boolean;
			run: () => Promise<void> | undefined;
		}> = [
			{
				name: "resume",
				span: SPAN_NAMES.sessionResume,
				supported: Boolean(
					client.supportsResumeSession?.() && client.resumeSession,
				),
				run: () => client.resumeSession?.(mapping.acpSessionId, request),
			},
			{
				name: "load",
				span: SPAN_NAMES.sessionLoad,
				supported: Boolean(
					client.supportsLoadSession?.() && client.loadSession,
				),
				run: () => client.loadSession?.(mapping.acpSessionId, request),
			},
		];

		for (const rung of rungs) {
			if (!rung.supported) {
				continue;
			}

			this.replaying.add(mapping.acpSessionId);

			try {
				await withSpan(
					{ name: rung.span, correlation: sessionCorrelation },
					rung.run,
				);
				runtime.liveSessions.add(mapping.acpSessionId);

				return true;
			} catch (error) {
				this.logger.warn(`ACP session ${rung.name} failed.`, {
					agentId,
					acpSessionId: mapping.acpSessionId,
					error: toMessage(error),
				});
			} finally {
				this.replaying.delete(mapping.acpSessionId);
			}
		}

		return false;
	}

	private createAcpClient(
		agentId: string,
		agentConfig: AgentConfig,
	): AcpClient {
		if (this.acpClientFactory) {
			return this.acpClientFactory(agentId, agentConfig);
		}

		if ((agentConfig.type ?? "stdio") !== "stdio") {
			throw new Error(
				`Agent "${agentId}" uses unsupported transport "${agentConfig.type}".`,
			);
		}

		return new StdioAcpClient({
			id: agentId,
			command: agentConfig.command,
			args: agentConfig.args ?? [],
			cwd: agentConfig.cwd,
			env: agentConfig.env,
		});
	}

	/**
	 * Entry point for every `session/update`. Updates for one ACP session are
	 * handled strictly in order; the returned promise settles when this one has
	 * been handled.
	 */
	private handleAcpSessionUpdate(params: unknown): Promise<void> {
		const acpSessionId = getAcpSessionId(params);
		const attached = acpSessionId
			? this.acpConnections.get(acpSessionId)
			: undefined;

		// A remote client gets the session's updates as they are, replays
		// included: it asked for them.
		if (attached) {
			return Promise.resolve()
				.then(() => attached.client.notification("session/update", params))
				.catch((error) => {
					this.logger.warn("A channel failed to take a session update.", {
						acpSessionId,
						error: toMessage(error),
					});
				});
		}

		// Checked synchronously: a load's replay arrives before its response.
		if (!acpSessionId || this.replaying.has(acpSessionId)) {
			return Promise.resolve();
		}

		// Whether this update belongs to a turn is decided when it arrives, not
		// when its turn in the chain comes: by then the prompt may have answered.
		const inTurn = this.turnsInFlight.has(acpSessionId);
		const previous = this.updateChains.get(acpSessionId) ?? Promise.resolve();
		const next = previous
			.then(() => this.processAcpSessionUpdate(acpSessionId, params, inTurn))
			.catch((error) => {
				this.logger.warn("Failed to handle an ACP session update.", {
					acpSessionId,
					error: toMessage(error),
				});
			});

		this.updateChains.set(acpSessionId, next);
		void next.then(() => {
			if (this.updateChains.get(acpSessionId) === next) {
				this.updateChains.delete(acpSessionId);
			}
		});

		return next;
	}

	/** Wait until every update received so far for a session has been handled. */
	private async settleUpdates(acpSessionId: string): Promise<void> {
		await this.updateChains.get(acpSessionId);
	}

	private async processAcpSessionUpdate(
		acpSessionId: string,
		params: unknown,
		inTurn: boolean,
	): Promise<void> {
		const mapping = await this.resolveMapping(acpSessionId);
		const channel = mapping ? this.channels.get(mapping.channelId) : undefined;
		const update = parseSessionUpdate(params);

		if (!mapping || !channel || !update) {
			return;
		}

		const mode = channel.config.delivery.mode;
		const capabilities = channel.adapter.manifest.capabilities ?? {};
		const origin = inTurn ? "turn" : "push";
		const event = this.toOutboundEvent(acpSessionId, update);

		// sendEvents forwards every update (including ones like plans that have
		// no structured form yet) with its raw payload, for channels that render
		// structured events themselves.
		if (mode === "sendEvents") {
			await this.enqueueDelivery(mapping, {
				conversationId: mapping.conversationId,
				origin,
				...(update.kind === "message" ? { text: update.text } : {}),
				...(event ? { event } : {}),
				raw: params,
			});
			return;
		}

		switch (update.kind) {
			case "message": {
				// A chunk the agent marks as a push is its own message even when it
				// lands in the middle of a turn.
				const pushed = !inTurn || update.final || update.pushId !== undefined;

				if (!pushed) {
					await this.flushSegment(mapping, "thought");
					this.bufferTurnText(mapping, channel, update.text);
					return;
				}

				if (mode === "streamChunks") {
					await this.enqueueDelivery(mapping, {
						conversationId: mapping.conversationId,
						origin: "push",
						text: update.text,
					});
					return;
				}

				await this.appendSegment(mapping, channel, {
					kind: "push",
					text: update.text,
					pushId: update.pushId,
					origin: "push",
				});

				if (update.final) {
					await this.flushSegment(mapping);
				}

				return;
			}

			case "attachment": {
				const pushed = !inTurn || update.final || update.pushId !== undefined;

				if (!pushed && mode === "bufferUntilTurnEnd") {
					const held = this.turnAttachments.get(acpSessionId) ?? [];
					held.push(update.attachment);
					this.turnAttachments.set(acpSessionId, held);
					return;
				}

				// After what was said before it, as a tool call is.
				await this.flushSegment(mapping);

				if (mode === "debounceChunks" && inTurn) {
					this.clearDebounceTimer(acpSessionId);
					await this.flushDebouncedBatch(mapping);
				}

				await this.deliverAttachment(
					mapping,
					update.attachment,
					pushed ? "push" : origin,
				);
				return;
			}

			case "thought": {
				if (!capabilities.thoughts) {
					return;
				}

				if (mode === "streamChunks") {
					await this.flushSegment(mapping);
					await this.enqueueDelivery(mapping, {
						conversationId: mapping.conversationId,
						origin,
						event: { type: "thought", text: update.text },
					});
					return;
				}

				await this.appendSegment(mapping, channel, {
					kind: "thought",
					text: update.text,
					origin,
				});
				return;
			}

			case "toolCall": {
				if (!capabilities.toolCalls || !event) {
					return;
				}

				// Keep the conversation in order: what was said before the call is
				// sent before it (a turn's buffered reply still waits for turn end).
				await this.flushSegment(mapping);

				if (mode === "debounceChunks" && inTurn) {
					this.clearDebounceTimer(acpSessionId);
					await this.flushDebouncedBatch(mapping);
				}

				await this.enqueueDelivery(mapping, {
					conversationId: mapping.conversationId,
					origin,
					event,
				});
				return;
			}

			default:
				return;
		}
	}

	/** Send what a buffered turn held back, after its reply. */
	private async flushTurnAttachments(mapping: SessionMapping): Promise<void> {
		const held = this.turnAttachments.get(mapping.acpSessionId);
		this.turnAttachments.delete(mapping.acpSessionId);

		for (const attachment of held ?? []) {
			await this.deliverAttachment(mapping, attachment, "turn");
		}
	}

	/**
	 * One file, to a channel that can carry it, or said in text to one that
	 * cannot. Never dropped: a file that is gone, or that the channel refused,
	 * is reported in the conversation where it was expected.
	 */
	private async deliverAttachment(
		mapping: SessionMapping,
		attachment: AcpAttachment,
		origin: "turn" | "push",
	): Promise<void> {
		const channel = this.channels.get(mapping.channelId);

		if (!channel) {
			return;
		}

		const resolved = await resolveAttachment(attachment);
		const say = (text: string) =>
			this.enqueueDelivery(mapping, {
				conversationId: mapping.conversationId,
				origin,
				text,
			});

		if (!resolved.ok) {
			this.logger.warn("An attachment could not be sent.", {
				conversationId: mapping.conversationId,
				name: resolved.name,
				reason: resolved.reason,
			});
			await say(attachmentNotice(resolved, resolved.reason));
			return;
		}

		if (!channel.adapter.manifest.capabilities?.attachments) {
			await say(attachmentAsText(resolved.attachment));
			return;
		}

		const failure = await this.enqueueDelivery(mapping, {
			conversationId: mapping.conversationId,
			origin,
			attachment: resolved.attachment,
		});

		// A channel that refused it has usually said why in the conversation
		// itself (too large for the server); this covers the rest, a failure
		// that outlasted every retry.
		if (failure) {
			await say(attachmentNotice(resolved.attachment, failure));
		}
	}

	/** The structured event for an update, remembering tool calls by id. */
	private toOutboundEvent(
		acpSessionId: string,
		update: AcpSessionUpdate,
	): ChannelOutboundEvent | undefined {
		if (update.kind === "thought") {
			return { type: "thought", text: update.text };
		}

		if (update.kind !== "toolCall") {
			return undefined;
		}

		const known = this.toolCalls.get(acpSessionId) ?? new Map();
		const merged: ChannelToolCall = {
			...known.get(update.toolCall.id),
			...update.toolCall,
		};

		if (merged.status === "completed" || merged.status === "failed") {
			known.delete(merged.id);
		} else {
			known.set(merged.id, merged);
		}

		this.toolCalls.set(acpSessionId, known);

		return { type: "toolCall", toolCall: merged, update: update.update };
	}

	/** In-turn reply text, under the channel's delivery mode. */
	private bufferTurnText(
		mapping: SessionMapping,
		channel: ChannelRuntime,
		text: string,
	): void {
		const mode = channel.config.delivery.mode;

		if (mode === "streamChunks") {
			void this.enqueueDelivery(mapping, {
				conversationId: mapping.conversationId,
				origin: "turn",
				text,
			});
			return;
		}

		// bufferUntilTurnEnd / debounceChunks: accumulate chunks.
		const buffer = this.deliveryBuffers.get(mapping.acpSessionId) ?? [];
		buffer.push(text);
		this.deliveryBuffers.set(mapping.acpSessionId, buffer);

		if (mode === "debounceChunks") {
			this.scheduleDebounceFlush(mapping, channel.config.delivery.debounceMs);
		}
	}

	/**
	 * Add to the session's pending segment, sending the one before it first if
	 * it was a different kind. The segment is sent after `pushIdleMs` of quiet.
	 */
	private async appendSegment(
		mapping: SessionMapping,
		channel: ChannelRuntime,
		chunk: {
			kind: PendingSegment["kind"];
			text: string;
			pushId?: string;
			origin: PendingSegment["origin"];
		},
	): Promise<void> {
		const id = mapping.acpSessionId;
		const current = this.segments.get(id);

		if (current && current.kind !== chunk.kind) {
			await this.flushSegment(mapping);
		}

		const segment: PendingSegment = this.segments.get(id) ?? {
			kind: chunk.kind,
			parts: [],
			origin: chunk.origin,
		};

		segment.parts.push(chunk.text);
		segment.pushId ??= chunk.pushId;

		if (segment.timer) {
			clearTimeout(segment.timer);
		}

		segment.timer = setTimeout(() => {
			void this.flushSegment(mapping);
		}, channel.config.delivery.pushIdleMs);
		(segment.timer as { unref?: () => void }).unref?.();
		this.segments.set(id, segment);
	}

	/** Send the session's pending segment now (only if it is of `kind`, when given). */
	private async flushSegment(
		mapping: SessionMapping,
		kind?: PendingSegment["kind"],
	): Promise<void> {
		const segment = this.segments.get(mapping.acpSessionId);

		if (!segment || (kind && segment.kind !== kind)) {
			return;
		}

		this.dropSegment(mapping.acpSessionId);

		const text = segment.parts.join("");

		if (!text) {
			return;
		}

		await this.enqueueDelivery(
			mapping,
			segment.kind === "thought"
				? {
						conversationId: mapping.conversationId,
						origin: segment.origin,
						event: { type: "thought", text },
					}
				: {
						...(segment.pushId ? { id: `push:${segment.pushId}` } : {}),
						conversationId: mapping.conversationId,
						origin: "push",
						text,
					},
		);
	}

	private dropSegment(acpSessionId: string): void {
		const segment = this.segments.get(acpSessionId);

		if (segment?.timer) {
			clearTimeout(segment.timer);
		}

		this.segments.delete(acpSessionId);
	}

	private scheduleDebounceFlush(
		mapping: SessionMapping,
		debounceMs: number,
	): void {
		const existing = this.deliveryDebounceTimers.get(mapping.acpSessionId);

		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this.deliveryDebounceTimers.delete(mapping.acpSessionId);
			void this.flushDebouncedBatch(mapping);
		}, debounceMs);

		(timer as { unref?: () => void }).unref?.();
		this.deliveryDebounceTimers.set(mapping.acpSessionId, timer);
	}

	/** Flush the current debounce batch mid-turn (a partial message). */
	private async flushDebouncedBatch(mapping: SessionMapping): Promise<void> {
		const buffered = this.deliveryBuffers.get(mapping.acpSessionId);

		if (!buffered || buffered.length === 0) {
			return;
		}

		this.deliveryBuffers.set(mapping.acpSessionId, []);

		await this.enqueueDelivery(mapping, {
			conversationId: mapping.conversationId,
			origin: "turn",
			text: buffered.join(""),
		});
	}

	private async flushDelivery(
		mapping: SessionMapping,
		promptCycleId: string | undefined,
	): Promise<void> {
		const timer = this.deliveryDebounceTimers.get(mapping.acpSessionId);

		if (timer) {
			clearTimeout(timer);
			this.deliveryDebounceTimers.delete(mapping.acpSessionId);
		}

		const buffered = this.deliveryBuffers.get(mapping.acpSessionId);
		this.deliveryBuffers.delete(mapping.acpSessionId);

		if (!buffered || buffered.length === 0) {
			return;
		}

		await this.enqueueDelivery(mapping, {
			id: deliveryId(promptCycleId, "message"),
			conversationId: mapping.conversationId,
			origin: "turn",
			text: buffered.join(""),
		});
	}

	/** Resolves to why the message was not delivered, or undefined when it was. */
	private async enqueueDelivery(
		mapping: SessionMapping,
		outbound: ChannelOutboundMessage,
	): Promise<string | undefined> {
		const channel = this.channels.get(mapping.channelId);

		if (!channel) {
			return "the channel is not running.";
		}

		// Fix a stable id up front so retries reuse it and idempotent channels can
		// de-duplicate rather than double-post.
		const message: ChannelOutboundMessage = {
			...outbound,
			id: outbound.id ?? crypto.randomUUID(),
		};

		return await this.requireDeliveryQueue().enqueue(
			`${mapping.channelId}:${mapping.conversationId}`,
			() =>
				this.sendWithRetry(channel, message, correlationFromMapping(mapping)),
		);
	}

	/** Resolves to why it gave up, or undefined once delivered. */
	private async sendWithRetry(
		channel: ChannelRuntime,
		message: ChannelOutboundMessage,
		correlation: CorrelationContext,
	): Promise<string | undefined> {
		const { maxAttempts, backoffMs } = channel.config.delivery.retry;
		let attempt = 0;

		while (true) {
			attempt += 1;

			try {
				const ack = await withSpan(
					{
						name: SPAN_NAMES.deliverySend,
						correlation,
						attributes: { "delivery.attempt": attempt },
					},
					() => channel.adapter.send(message),
				);

				if (ack.ok) {
					this.clearDeliveryFailure(correlation.channelId);
					return undefined;
				}

				// A structured failure is only retryable when the adapter says so via
				// `retryAfterMs`; otherwise it is terminal.
				if (attempt >= maxAttempts || ack.retryAfterMs == null) {
					this.logger.warn("Outbound delivery failed; giving up.", {
						conversationId: message.conversationId,
						messageId: message.id,
						attempt,
						error: ack.error,
					});
					this.recordDeliveryFailure(
						correlation.channelId,
						ack.error ?? "Delivery failed.",
					);
					return ack.error ?? "Delivery failed.";
				}

				await delay(ack.retryAfterMs);
			} catch (error) {
				// A thrown error is treated as transient and retried with backoff.
				if (attempt >= maxAttempts) {
					this.logger.warn("Outbound delivery threw; giving up.", {
						conversationId: message.conversationId,
						messageId: message.id,
						attempt,
						error: toMessage(error),
					});
					this.recordDeliveryFailure(correlation.channelId, error);
					return toMessage(error);
				}

				await delay(backoffMs * 2 ** (attempt - 1));
			}
		}
	}

	private recordDeliveryFailure(
		channelId: string | undefined,
		error: unknown,
	): void {
		if (channelId) {
			this.recordChannelError(channelId, error);
		}
	}

	/** A send that went through clears a failing state that sends caused. */
	private clearDeliveryFailure(channelId: string | undefined): void {
		const current = channelId ? this.channelStatus.get(channelId) : undefined;

		if (
			channelId &&
			current?.state === "failing" &&
			this.channels.has(channelId)
		) {
			this.setChannelState(channelId, "ready");
		}
	}

	private requireStateStore(): StateStore {
		if (!this.stateStore) {
			throw new Error("Gateway state store has not been initialized.");
		}

		return this.stateStore;
	}

	private requirePromptQueue(): SerialQueue {
		if (!this.promptQueue) {
			throw new Error("Gateway prompt queue has not been initialized.");
		}

		return this.promptQueue;
	}

	private requireDeliveryQueue(): SerialQueue {
		if (!this.deliveryQueue) {
			throw new Error("Gateway delivery queue has not been initialized.");
		}

		return this.deliveryQueue;
	}
}

/**
 * Serializes work per key as an in-process FIFO chain: each key runs one item
 * at a time, in submission order, while different keys run concurrently. Used
 * for both per-session prompts and per-conversation outbound delivery. It holds
 * live in-memory closures, so it is not durable across restarts by design.
 */
class SerialQueue {
	private readonly tails = new Map<string, Promise<unknown>>();
	private closed = false;

	public constructor(private readonly label: string) {}

	public async enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
		if (this.closed) {
			throw new Error(`Gateway ${this.label} queue is closed.`);
		}

		const previous = this.tails.get(key) ?? Promise.resolve();

		// `previous` is the (never-rejecting) tail of the key's chain, so this work
		// starts only after all earlier work for the key has settled. A failure is
		// isolated to its own caller and never reorders or blocks later work.
		const run = previous.then(() => work());
		const tail = run.catch(() => undefined);

		this.tails.set(key, tail);

		// Drop the map entry once this is the last item in the chain so idle keys
		// do not leak.
		void tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});

		return await run;
	}

	/** Resolve once every key's chain has drained (without closing the queue). */
	public async idle(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.allSettled([...this.tails.values()]);
		}
	}

	public async close(): Promise<void> {
		this.closed = true;

		// Let in-flight chains settle so shutdown does not drop running work.
		await Promise.allSettled([...this.tails.values()]);

		this.tails.clear();
	}
}

export class MemoryStateStore implements StateStore {
	private readonly sessions = new Map<string, SessionMapping>();
	private readonly events = new Map<string, InboundEventRecord>();

	public async getSession(
		channelId: string,
		sessionKey: string,
	): Promise<SessionMapping | undefined> {
		return this.sessions.get(`${channelId}:${sessionKey}`);
	}

	public async findByAcpSessionId(
		acpSessionId: string,
	): Promise<SessionMapping | undefined> {
		return [...this.sessions.values()].find(
			(mapping) => mapping.acpSessionId === acpSessionId,
		);
	}

	public async setSession(mapping: SessionMapping): Promise<void> {
		this.sessions.set(`${mapping.channelId}:${mapping.sessionKey}`, mapping);
	}

	public async deleteSession(
		channelId: string,
		sessionKey: string,
	): Promise<void> {
		this.sessions.delete(`${channelId}:${sessionKey}`);
	}

	public async listSessions(): Promise<SessionMapping[]> {
		return [...this.sessions.values()];
	}

	public async saveEvent(record: InboundEventRecord): Promise<void> {
		this.events.set(record.id, record);
	}

	public async setEventStatus(
		id: string,
		status: InboundEventStatus,
		attempts: number,
	): Promise<void> {
		const record = this.events.get(id);

		if (record) {
			this.events.set(id, {
				...record,
				status,
				attempts,
				updatedAt: new Date().toISOString(),
			});
		}
	}

	public async deleteEvent(id: string): Promise<void> {
		this.events.delete(id);
	}

	public async listEvents(): Promise<InboundEventRecord[]> {
		return [...this.events.values()];
	}
}

export class SqliteStateStore implements StateStore {
	private readonly database: Database;

	public constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new Database(path, { create: true });
		this.database.run(`
      create table if not exists sessions (
        channel_id text not null,
        session_key text not null,
        agent_id text not null,
        acp_session_id text not null,
        conversation_id text not null,
        updated_at text not null,
        cwd text,
        connection integer not null default 0,
        primary key (channel_id, session_key)
      )
    `);
		// Added after the first release: a database from before has every row
		// as it was, with no directory and no connection.
		const columns = new Set(
			(
				this.database.query("pragma table_info(sessions)").all() as Array<{
					name: string;
				}>
			).map((column) => column.name),
		);

		if (!columns.has("cwd")) {
			this.database.run("alter table sessions add column cwd text");
		}

		if (!columns.has("connection")) {
			this.database.run(
				"alter table sessions add column connection integer not null default 0",
			);
		}

		this.database.run(
			"create index if not exists sessions_acp_session_id on sessions(acp_session_id)",
		);
		this.database.run(`
      create table if not exists events (
        id text primary key,
        channel_id text not null,
        session_key text not null,
        status text not null,
        event_json text not null,
        attempts integer not null,
        created_at text not null,
        updated_at text not null
      )
    `);
	}

	public async getSession(
		channelId: string,
		sessionKey: string,
	): Promise<SessionMapping | undefined> {
		const row = this.database
			.query("select * from sessions where channel_id = ? and session_key = ?")
			.get(channelId, sessionKey) as SessionRow | null;

		return row ? rowToMapping(row) : undefined;
	}

	public async findByAcpSessionId(
		acpSessionId: string,
	): Promise<SessionMapping | undefined> {
		const row = this.database
			.query("select * from sessions where acp_session_id = ?")
			.get(acpSessionId) as SessionRow | null;

		return row ? rowToMapping(row) : undefined;
	}

	public async setSession(mapping: SessionMapping): Promise<void> {
		this.database
			.query(`
        insert into sessions (channel_id, session_key, agent_id, acp_session_id, conversation_id, updated_at, cwd, connection)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(channel_id, session_key) do update set
          agent_id = excluded.agent_id,
          acp_session_id = excluded.acp_session_id,
          conversation_id = excluded.conversation_id,
          updated_at = excluded.updated_at,
          cwd = excluded.cwd,
          connection = excluded.connection
      `)
			.run(
				mapping.channelId,
				mapping.sessionKey,
				mapping.agentId,
				mapping.acpSessionId,
				mapping.conversationId,
				mapping.updatedAt,
				mapping.cwd ?? null,
				mapping.connection ? 1 : 0,
			);
	}

	public async deleteSession(
		channelId: string,
		sessionKey: string,
	): Promise<void> {
		this.database
			.query("delete from sessions where channel_id = ? and session_key = ?")
			.run(channelId, sessionKey);
	}

	public async listSessions(): Promise<SessionMapping[]> {
		const rows = this.database
			.query("select * from sessions order by updated_at desc")
			.all() as SessionRow[];

		return rows.map(rowToMapping);
	}

	public async saveEvent(record: InboundEventRecord): Promise<void> {
		this.database
			.query(`
        insert into events (id, channel_id, session_key, status, event_json, attempts, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          status = excluded.status,
          event_json = excluded.event_json,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at
      `)
			.run(
				record.id,
				record.channelId,
				record.sessionKey,
				record.status,
				JSON.stringify(record.event),
				record.attempts,
				record.createdAt,
				record.updatedAt,
			);
	}

	public async setEventStatus(
		id: string,
		status: InboundEventStatus,
		attempts: number,
	): Promise<void> {
		this.database
			.query(
				"update events set status = ?, attempts = ?, updated_at = ? where id = ?",
			)
			.run(status, attempts, new Date().toISOString(), id);
	}

	public async deleteEvent(id: string): Promise<void> {
		this.database.query("delete from events where id = ?").run(id);
	}

	public async listEvents(): Promise<InboundEventRecord[]> {
		const rows = this.database
			.query("select * from events order by created_at asc")
			.all() as EventRow[];

		return rows.map(rowToEventRecord);
	}

	public close(): void {
		this.database.close();
	}
}

/** A channel that carries its connections' ACP to a remote client. */
function carriesAcp(channel: ChannelRuntime): boolean {
	return (
		channel.adapter.manifest.capabilities?.acp === true &&
		typeof channel.adapter.attachAcp === "function"
	);
}

export function createStateStore(config: ResolvedAcpAntennaConfig): StateStore {
	if (config.state.driver === "memory") {
		return new MemoryStateStore();
	}

	return new SqliteStateStore(config.state.path);
}

/**
 * Whether a session mapping has been idle past its TTL. An undefined/zero TTL
 * means "never expire". An unparseable timestamp is treated as expired so a
 * corrupt row gets reclaimed rather than lingering forever.
 */
export function isMappingExpired(
	updatedAt: string,
	ttlSeconds: number | undefined,
	now: number,
): boolean {
	if (!ttlSeconds || ttlSeconds <= 0) {
		return false;
	}

	const updatedAtMs = Date.parse(updatedAt);

	if (Number.isNaN(updatedAtMs)) {
		return true;
	}

	return now - updatedAtMs > ttlSeconds * 1000;
}

/**
 * A channel-visible notice for a prompt turn that ended abnormally, or
 * `undefined` for a normal completion (`end_turn`) or an intentional
 * `cancelled`, where no extra message is warranted.
 */
export function stopReasonNotice(stopReason: string): string | undefined {
	switch (stopReason) {
		case "max_tokens":
			return "⚠️ The agent stopped early because it reached its maximum token limit.";
		case "max_turn_requests":
			return "⚠️ The agent stopped early because it reached the maximum number of requests for this turn.";
		case "refusal":
			return "⚠️ The agent declined to respond to that request.";
		default:
			return undefined;
	}
}

export function resolveSessionKey(
	channelId: string,
	event: ChannelInboundEvent,
	session: SessionPolicyConfig,
): string {
	switch (session.strategy ?? "perConversation") {
		case "perSender":
			return `${channelId}:sender:${event.sender.id}`;
		case "manualKeyTemplate":
			return (session.keyTemplate ?? "{channel}:{conversation}")
				.replaceAll("{channel}", channelId)
				.replaceAll("{conversation}", event.conversation.id)
				.replaceAll("{sender}", event.sender.id);
		default:
			return `${channelId}:conversation:${event.conversation.id}`;
	}
}

/**
 * The session key of a conversation, as `resolveSessionKey` would make it for
 * any message there; undefined when the channel keys sessions by sender, so a
 * conversation alone does not name one.
 */
export function conversationSessionKey(
	channelId: string,
	conversationId: string,
	session: SessionPolicyConfig,
): string | undefined {
	const strategy = session.strategy ?? "perConversation";

	if (
		strategy === "perSender" ||
		(strategy === "manualKeyTemplate" &&
			(session.keyTemplate ?? "").includes("{sender}"))
	) {
		return undefined;
	}

	return resolveSessionKey(
		channelId,
		{
			conversation: { id: conversationId },
			sender: { id: "" },
		} as ChannelInboundEvent,
		session,
	);
}

/** What a replacement mapping keeps of a connection: that it is one, and its directory. */
function connectionFields(
	mapping: SessionMapping | undefined,
): Pick<SessionMapping, "connection" | "cwd"> {
	if (!mapping?.connection) {
		return {};
	}

	return { connection: true, ...(mapping.cwd ? { cwd: mapping.cwd } : {}) };
}

class GatewayRouteRegistry implements ChannelRouteRegistry {
	public constructor(
		private readonly prefix: string,
		private readonly routes: RouteDefinition[],
	) {}

	public route(
		method: string,
		path: string,
		handler: ChannelRouteHandler,
	): void {
		this.routes.push({
			method: method.toUpperCase(),
			path: normalizeRoutePath(`${this.prefix}/${path}`),
			handler,
		});
	}
}

interface SessionRow {
	channel_id: string;
	session_key: string;
	agent_id: string;
	acp_session_id: string;
	conversation_id: string;
	updated_at: string;
	cwd: string | null;
	connection: number;
}

function rowToMapping(row: SessionRow): SessionMapping {
	return {
		channelId: row.channel_id,
		sessionKey: row.session_key,
		agentId: row.agent_id,
		acpSessionId: row.acp_session_id,
		conversationId: row.conversation_id,
		updatedAt: row.updated_at,
		...(row.cwd ? { cwd: row.cwd } : {}),
		...(row.connection ? { connection: true } : {}),
	};
}

interface EventRow {
	id: string;
	channel_id: string;
	session_key: string;
	status: string;
	event_json: string;
	attempts: number;
	created_at: string;
	updated_at: string;
}

function rowToEventRecord(row: EventRow): InboundEventRecord {
	return {
		id: row.id,
		channelId: row.channel_id,
		sessionKey: row.session_key,
		status: row.status as InboundEventStatus,
		event: JSON.parse(row.event_json) as ChannelInboundEvent,
		attempts: row.attempts,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function normalizeRoutePath(path: string): string {
	const normalized = path.replaceAll(/\/+/g, "/");
	const withoutTrailingSlash =
		normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;

	return withoutTrailingSlash.startsWith("/")
		? withoutTrailingSlash
		: `/${withoutTrailingSlash}`;
}

export function isEventAllowed(
	channelConfig: Pick<ResolvedChannelConfig, "permissions">,
	event: ChannelInboundEvent,
): boolean {
	if (event.sender.trusted) {
		return true;
	}

	const inbound = channelConfig.permissions.inbound;

	if (inbound.mode === "open") {
		return true;
	}

	if (inbound.mode === "closed") {
		return false;
	}

	return (
		inbound.allow.includes("*") ||
		inbound.allow.includes(event.sender.id) ||
		inbound.allow.includes(event.conversation.id) ||
		(event.conversation.parentIds ?? []).some((id) =>
			inbound.allow.includes(id),
		)
	);
}

/**
 * `<state dir>/channels/<channel id>`: a channel's own files, beside the state
 * store. The id is a config key, kept to safe file-name characters.
 */
export function channelStateDir(statePath: string, channelId: string): string {
	const safe = channelId.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(dirname(statePath), "channels", /^\.*$/.test(safe) ? "_" : safe);
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A stable idempotency id for an outbound message, derived from the (durable)
 * prompt cycle id — which is the inbound event id — so a recovery replay of the
 * same event produces the same outbound id and an idempotent channel de-dupes
 * rather than double-posting. Deliberately excludes the ACP session id, which
 * can change across a replay.
 */
function deliveryId(
	promptCycleId: string | undefined,
	kind: string,
): string | undefined {
	return promptCycleId ? `${promptCycleId}:${kind}` : undefined;
}

function correlationFromMapping(mapping: SessionMapping): CorrelationContext {
	return {
		channelId: mapping.channelId,
		conversationId: mapping.conversationId,
		sessionKey: mapping.sessionKey,
		agentId: mapping.agentId,
		acpSessionId: mapping.acpSessionId,
	};
}

function permissionResponse(
	optionId: string | undefined,
): RequestPermissionResponse {
	return optionId
		? { outcome: { outcome: "selected", optionId } }
		: { outcome: { outcome: "cancelled" } };
}

/**
 * Choose the option id to answer a permission request with, preferring the
 * "once" variant over "always". Returns undefined when the agent offered no
 * matching option (the caller then cancels).
 */
export function selectPermissionOptionId(
	options: Array<{ optionId: string; kind?: string }>,
	decision: "allow" | "reject",
): string | undefined {
	const order =
		decision === "allow"
			? ["allow_once", "allow_always"]
			: ["reject_once", "reject_always"];

	for (const kind of order) {
		const match = options.find((option) => option.kind === kind);

		if (match) {
			return match.optionId;
		}
	}

	return undefined;
}

function parsePermissionOptions(params: unknown): PermissionOptionLike[] {
	if (!isRecord(params) || !Array.isArray(params.options)) {
		return [];
	}

	const options: PermissionOptionLike[] = [];

	for (const option of params.options) {
		if (isRecord(option) && typeof option.optionId === "string") {
			options.push({
				optionId: option.optionId,
				name: typeof option.name === "string" ? option.name : undefined,
				kind: typeof option.kind === "string" ? option.kind : undefined,
			});
		}
	}

	return options;
}

interface ParsedElicitation {
	mode: string;
	message: string;
	fields: ElicitationField[];
}

/**
 * Extracts the routable shape of an ACP elicitation request: its mode, the
 * human-readable message, and the form fields derived from `requestedSchema`.
 * Returns `undefined` when the payload is not a well-formed elicitation.
 */
function parseElicitation(params: unknown): ParsedElicitation | undefined {
	if (!isRecord(params) || typeof params.mode !== "string") {
		return undefined;
	}

	const message = typeof params.message === "string" ? params.message : "";
	const schema = isRecord(params.requestedSchema)
		? params.requestedSchema
		: undefined;
	const properties =
		schema && isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema?.required)
			? schema.required.filter(
					(name): name is string => typeof name === "string",
				)
			: [],
	);

	const fields: ElicitationField[] = [];

	for (const [name, definition] of Object.entries(properties)) {
		fields.push(parseElicitationField(name, definition, required.has(name)));
	}

	return { mode: params.mode, message, fields };
}

type EnumValue = string | number | boolean;

function isEnumValue(value: unknown): value is EnumValue {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

/**
 * One form field: its type and, when the schema gives them, its title,
 * description and allowed values. Values come from `enum` (titled by the
 * legacy `enumNames`) or from the `const`s of `oneOf`/`anyOf` (titled by each
 * branch's `title`).
 */
function parseElicitationField(
	name: string,
	definition: unknown,
	required: boolean,
): ElicitationField {
	const schema = isRecord(definition) ? definition : {};
	const field: ElicitationField = {
		name,
		type: typeof schema.type === "string" ? schema.type : "string",
		required,
	};

	if (typeof schema.title === "string") {
		field.title = schema.title;
	}

	if (typeof schema.description === "string") {
		field.description = schema.description;
	}

	let values: EnumValue[] = [];
	let titles: Array<string | undefined> = [];

	if (Array.isArray(schema.enum)) {
		values = schema.enum.filter(isEnumValue);
		titles = Array.isArray(schema.enumNames)
			? schema.enumNames.map((title) =>
					typeof title === "string" ? title : undefined,
				)
			: [];
	} else {
		const branches = Array.isArray(schema.oneOf)
			? schema.oneOf
			: Array.isArray(schema.anyOf)
				? schema.anyOf
				: [];

		for (const branch of branches) {
			if (isRecord(branch) && isEnumValue(branch.const)) {
				values.push(branch.const);
				titles.push(
					typeof branch.title === "string" ? branch.title : undefined,
				);
			}
		}
	}

	if (values.length > 0) {
		field.enum = values;

		if (titles.some((title) => title !== undefined)) {
			field.enumTitles = values.map(
				(value, index) => titles[index] ?? String(value),
			);
		}
	}

	return field;
}

/**
 * The form's field, when the whole form is one required enum: then a channel
 * with buttons can offer its values as options to click.
 */
function singleChoiceField(
	fields: ElicitationField[],
): ElicitationField | undefined {
	const [only] = fields;

	return fields.length === 1 && only?.required && only.enum?.length
		? only
		: undefined;
}

function choiceOptions(field: ElicitationField): ChannelInteractionOption[] {
	return (field.enum ?? []).map((value, index) => ({
		id: String(value),
		label: field.enumTitles?.[index] ?? String(value),
		kind: "choice",
	}));
}

/** A field in the text fallback: `answer* (one of: yes, no) — Ship it?`. */
function describeFieldForText(field: ElicitationField): string {
	const kind = field.enum?.length
		? `one of: ${field.enum.map(String).join(", ")}`
		: field.type;
	const hint = field.description ?? field.title;

	return `${field.name}${field.required ? "*" : ""} (${kind})${hint ? ` — ${hint}` : ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeEventContent(event: ChannelInboundEvent): string {
	return JSON.stringify({
		type: event.type,
		content: event.content,
		sender: event.sender,
		conversation: event.conversation,
	});
}

/**
 * The MCP servers to hand an agent in `session/new` / `session/load`, in ACP's
 * wire shape: stdio servers carry `env` as `[{ name, value }]` (not a record)
 * and no `type`; http/sse servers carry `type`, `url` and `headers`.
 */
export function resolveMcpServers(
	allServers: McpServerConfig[],
	agentConfig: AgentConfig,
): AcpMcpServer[] {
	const serverIds = new Set(agentConfig.mcpServers ?? []);
	const selected =
		serverIds.size === 0
			? allServers
			: allServers.filter((server) => serverIds.has(server.name));

	return selected.map(toAcpMcpServer);
}

export type AcpMcpServer =
	| {
			name: string;
			command: string;
			args: string[];
			env: Array<{ name: string; value: string }>;
	  }
	| {
			type: "http" | "sse";
			name: string;
			url: string;
			headers: Array<{ name: string; value: string }>;
	  };

function toAcpMcpServer(server: McpServerConfig): AcpMcpServer {
	if (server.type === "http" || server.type === "sse") {
		return {
			type: server.type,
			name: server.name,
			url: server.url ?? "",
			headers: server.headers ?? [],
		};
	}

	return {
		name: server.name,
		command: server.command ?? "",
		args: server.args ?? [],
		env: Object.entries(server.env ?? {}).map(([name, value]) => ({
			name,
			value,
		})),
	};
}

/**
 * A message that is exactly `/cancel`, `/new` or `/mode [id]` (surrounding
 * whitespace aside). Anything else, including `/mode` with extra words, is an
 * ordinary prompt.
 */
export function parseReservedCommand(
	text: string | undefined,
): ReservedCommand | undefined {
	const trimmed = text?.trim() ?? "";

	if (trimmed === "/cancel") {
		return { name: "cancel" };
	}

	if (trimmed === "/new") {
		return { name: "new" };
	}

	const mode = /^\/mode(?:\s+(\S+))?$/.exec(trimmed);

	if (mode) {
		return mode[1] ? { name: "mode", modeId: mode[1] } : { name: "mode" };
	}

	return undefined;
}

/** Whether a mapping was used within the last `days` days. */
export function isWithinDays(
	updatedAt: string,
	days: number,
	now: number,
): boolean {
	const updatedAtMs = Date.parse(updatedAt);

	return !Number.isNaN(updatedAtMs) && now - updatedAtMs <= days * 86_400_000;
}

function parsePermissionToolCall(params: unknown): ChannelToolCall | undefined {
	if (!isRecord(params) || !isRecord(params.toolCall)) {
		return undefined;
	}

	const toolCall = params.toolCall;

	if (typeof toolCall.toolCallId !== "string") {
		return undefined;
	}

	return {
		id: toolCall.toolCallId,
		...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
		...(typeof toolCall.kind === "string" ? { kind: toolCall.kind } : {}),
		...(typeof toolCall.status === "string" ? { status: toolCall.status } : {}),
	};
}

function getAcpSessionId(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return undefined;
	}

	const value = (params as { sessionId?: unknown }).sessionId;

	return typeof value === "string" ? value : undefined;
}
