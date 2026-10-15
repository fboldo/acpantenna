export type ChannelEventType = "message" | "reaction" | "delivery" | "system";
export type ChannelHealthState = "starting" | "ready" | "degraded" | "stopped";

/**
 * What a channel can render. Core consults it before choosing an outbound
 * shape: a capability left out (or false) gets the plain-text fallback, or
 * nothing at all for optional events.
 */
export interface ChannelCapabilities {
	inbound?: boolean;
	outbound?: boolean;
	routes?: boolean;
	approvals?: boolean;
	/**
	 * The channel can send a file (`ChannelOutboundMessage.attachment`). Others
	 * are told about one in text instead, never given nothing.
	 */
	attachments?: boolean;
	/**
	 * Interaction options can be shown as buttons. The channel then receives
	 * `interaction.options` as structured data and a short `text` without the
	 * "reply with one of" instructions.
	 */
	buttons?: boolean;
	/** The channel wants `toolCall` events (`event.type === "toolCall"`). */
	toolCalls?: boolean;
	/** The channel wants the agent's thoughts as `thought` events. */
	thoughts?: boolean;
	/**
	 * The channel carries a connection's ACP itself, to a remote ACP client,
	 * instead of turning it into chat messages. Core hands each connection to
	 * the adapter's `attachAcp`.
	 */
	acp?: boolean;
}

export interface ChannelManifest {
	type: string;
	name: string;
	version: string;
	capabilities?: ChannelCapabilities;
}

export interface ChannelConversation {
	id: string;
	type?: "dm" | "group" | "room" | "thread" | "unknown";
	title?: string;
}

export interface ChannelSender {
	id: string;
	displayName?: string;
	trusted?: boolean;
}

export interface ChannelContent {
	text?: string;
	blocks?: Array<Record<string, unknown>>;
	attachments?: Array<Record<string, unknown>>;
}

/** A user's answer to a pending interaction (a permission prompt or elicitation). */
export interface ChannelInteractionResponse {
	id: string;
	/** Selected option id (permission requests). */
	optionId?: string;
	/** Form values (elicitation requests). */
	content?: Record<string, string | number | boolean | string[]>;
	/** The user declined/cancelled the interaction. */
	declined?: boolean;
}

export interface ChannelInboundEvent {
	id: string;
	type: ChannelEventType | string;
	timestamp: string;
	conversation: ChannelConversation;
	sender: ChannelSender;
	content: ChannelContent;
	/** Set when this event answers a pending interaction rather than prompting. */
	interaction?: ChannelInteractionResponse;
	raw?: unknown;
}

/** One choice of an interaction. Answer with its `id` as `optionId`. */
export interface ChannelInteractionOption {
	id: string;
	label: string;
	/**
	 * For a permission, whether choosing it grants or refuses (ACP's `allow_*`
	 * / `reject_*`). `choice` is one value of an elicitation's single enum field.
	 */
	kind: "allow" | "reject" | "choice";
}

/** One field of an elicitation form, from the agent's `requestedSchema`. */
export interface ChannelElicitationField {
	name: string;
	/** JSON Schema type: string, number, integer, boolean. */
	type: string;
	required: boolean;
	title?: string;
	description?: string;
	/** The allowed values, from `enum` or the `const`s of `oneOf`/`anyOf`. */
	enum?: Array<string | number | boolean>;
	/** Display names for `enum`, same order, when the schema gives them. */
	enumTitles?: string[];
}

/** A normalized interaction (permission request or elicitation) for the channel to render. */
export interface ChannelInteractionPrompt {
	id: string;
	kind: "permission" | "elicitation";
	message?: string;
	/**
	 * Selectable options. Present only for channels that declare the `buttons`
	 * capability; others get the choices in `text`. A permission always has
	 * them; an elicitation has them (kind `choice`) when its form is a single
	 * required enum field, and answering with `optionId` fills that field.
	 */
	options?: ChannelInteractionOption[];
	/** Form fields to collect (elicitation requests). */
	fields?: ChannelElicitationField[];
	/** The tool call the permission is about, when the agent named one. */
	toolCall?: ChannelToolCall;
}

/** A tool call, as the agent announced or last updated it. */
export interface ChannelToolCall {
	id: string;
	title?: string;
	/** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. */
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed" | string;
}

/**
 * A structured event that is not reply text. Sent only to channels that
 * declare the matching capability (`toolCalls`, `thoughts`), or to every
 * channel in the `sendEvents` delivery mode.
 */
export type ChannelOutboundEvent =
	| {
			type: "toolCall";
			toolCall: ChannelToolCall;
			/** False for the first announcement, true for later status changes. */
			update: boolean;
	  }
	| { type: "thought"; text: string };

/**
 * A file the agent sent, for the channel to upload as itself. `image` is
 * shown inline where the channel can; everything else is a download.
 *
 * The bytes are either on this machine (`path`, which core has checked exists
 * and measured) or carried in the message (`data`). A channel reads a path
 * only after checking `size` against its own limit, so a file too large is
 * refused without being read into memory.
 */
export interface ChannelAttachment {
	name: string;
	mimeType: string;
	size: number;
	kind: AttachmentKind;
	path?: string;
	data?: Uint8Array;
}

export type AttachmentKind = "image" | "video" | "audio" | "file";

export interface ChannelOutboundMessage {
	id?: string;
	conversationId: string;
	inReplyTo?: string;
	text?: string;
	blocks?: Array<Record<string, unknown>>;
	interaction?: ChannelInteractionPrompt;
	event?: ChannelOutboundEvent;
	/** A file, sent only to channels with the `attachments` capability. */
	attachment?: ChannelAttachment;
	/**
	 * `turn` when the message answers a prompt from this conversation, `push`
	 * when the agent sent it between turns (an inbox card, a question).
	 */
	origin?: "turn" | "push";
	raw?: unknown;
}

export interface ChannelAck {
	ok: boolean;
	messageId?: string;
	retryAfterMs?: number;
	error?: string;
}

export interface ChannelHealth {
	state: ChannelHealthState;
	message?: string;
	checkedAt: string;
}

export interface ChannelLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

export type ChannelRouteHandler = (
	request: Request,
) => Response | Promise<Response>;

export interface ChannelRouteRegistry {
	route(method: string, path: string, handler: ChannelRouteHandler): void;
}

export interface ChannelContext<TConfig = unknown> {
	channelId: string;
	config: TConfig;
	/**
	 * A directory of this channel's own, beside the gateway's state store, for
	 * what it must keep across restarts (an encryption key store, a sync token).
	 * It may not exist yet; create it before writing.
	 */
	stateDir?: string;
	emit(event: ChannelInboundEvent): Promise<void> | void;
	logger: ChannelLogger;
}

export interface ChannelAdapter<TConfig = unknown> {
	manifest: ChannelManifest;
	start(context: ChannelContext<TConfig>): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(message: ChannelOutboundMessage): Promise<ChannelAck> | ChannelAck;
	health?(): Promise<ChannelHealth> | ChannelHealth;
	registerRoutes?(registry: ChannelRouteRegistry): void;
	/**
	 * A channel with the `acp` capability: a new connection, whose ACP the
	 * channel now carries. Resolves to the channel's end of it.
	 */
	attachAcp?(
		connection: ChannelAcpConnection,
	): Promise<ChannelAcpClient> | ChannelAcpClient;
	/**
	 * Forgets the keys the channel pairs with, so no link it gave out works
	 * again; the next pairing uses new ones. Core has already dropped the
	 * channel's connections.
	 */
	revoke?(): Promise<void> | void;
}

/**
 * One connection's agent session, as core hands it to a channel with the
 * `acp` capability. The channel speaks ACP to the agent through it, as the
 * agent's client for that session; core still owns the agent process and
 * the connection.
 */
export interface ChannelAcpConnection {
	readonly channelId: string;
	readonly conversationId: string;
	readonly agentId: string;
	/** The directory the connection works in. */
	readonly cwd: string;
	/** The session the connection is bound to. `newSession` changes it. */
	readonly acpSessionId: string;
	/** The agent's `initialize` response. */
	readonly initializeResult: unknown;
	/** The MCP servers the config gives the agent's sessions, as ACP has them. */
	readonly mcpServers: unknown[];
	/**
	 * Sends a request to the agent. Rejects with the agent's JSON-RPC error
	 * (`code`, `message`, `data`) when it answers with one.
	 */
	request(method: string, params: unknown): Promise<unknown>;
	notify(method: string, params: unknown): Promise<void>;
	/**
	 * `session/new` in the connection's directory with the configured MCP
	 * servers, and the connection bound to the new session.
	 */
	newSession(): Promise<Record<string, unknown>>;
	/** Drops the connection from the channel's side, as `kill` would. */
	end(reason: string): Promise<void>;
}

/** A channel's end of a connection it carries ACP for. */
export interface ChannelAcpClient {
	/** A notification from the agent about the connection's session. */
	notification(method: string, params: unknown): Promise<void> | void;
	/** A request from the agent about the connection's session; resolves to its result. */
	request(method: string, params: unknown): Promise<unknown>;
	/** Where pairing with the remote client stands, for a channel that pairs. */
	pairing?(): ChannelPairing;
	/** The user's answer to the words of a pairing in the `verifying` state. */
	confirmPairing?(accepted: boolean): Promise<void> | void;
	/** The connection was dropped (`kill`, the server stopping): let the remote client go. */
	close(reason: string): Promise<void> | void;
}

/**
 * How pairing a connection with a remote client goes: `waiting` for it to
 * open the link, `verifying` while the user compares the words, then
 * `connected`, or `ended`.
 */
export interface ChannelPairing {
	state: "waiting" | "verifying" | "connected" | "ended";
	/** What the user opens on the other device. */
	link?: string;
	/** When the link stops working, as an ISO date. */
	expiresAt?: string;
	/** The words both ends show; the user checks that they match. */
	words?: string[];
	/** Why it ended. */
	reason?: string;
	/** `connected`, but the remote client has gone for now and may come back. */
	away?: boolean;
}

export type ChannelFactory<TConfig = unknown> = (
	config: TConfig,
) => ChannelAdapter<TConfig>;

/** A JSON-Schema-ish description of one channel config field. */
export interface ChannelConfigField {
	type: "string" | "number" | "integer" | "boolean" | "array" | "object";
	title?: string;
	description?: string;
	/**
	 * The value is a credential. A settings UI should keep it in a secret store
	 * and write a `${ENV_VAR}` placeholder into the config, never the value.
	 */
	secret?: boolean;
	default?: unknown;
	enum?: unknown[];
	items?: ChannelConfigField;
	properties?: Record<string, ChannelConfigField>;
	required?: string[];
}

export interface ChannelConfigSchema {
	type: "object";
	properties: Record<string, ChannelConfigField>;
	required?: string[];
}

/**
 * Everything acpantenna knows about a channel type without starting one: the
 * factory, and the fields its config takes. `acpantenna channels --json`
 * prints these so another program can render a settings form.
 */
export interface ChannelDefinition<TConfig = unknown> {
	type: string;
	name: string;
	description?: string;
	capabilities?: ChannelCapabilities;
	/** The channel's own config fields, beside the generic ones every channel takes. */
	configSchema: ChannelConfigSchema;
	create: ChannelFactory<TConfig>;
}

export function defineChannel<TConfig>(
	definition: ChannelDefinition<TConfig>,
): ChannelDefinition<TConfig> {
	return definition;
}

export function createChannelAdapter<TConfig>(
	adapter: ChannelAdapter<TConfig>,
): ChannelAdapter<TConfig> {
	return adapter;
}

export function createTextInboundEvent(input: {
	id?: string;
	text: string;
	conversationId: string;
	conversationType?: ChannelConversation["type"];
	senderId: string;
	senderName?: string;
	trusted?: boolean;
	timestamp?: string;
	raw?: unknown;
}): ChannelInboundEvent {
	return {
		id: input.id ?? crypto.randomUUID(),
		type: "message",
		timestamp: input.timestamp ?? new Date().toISOString(),
		conversation: {
			id: input.conversationId,
			type: input.conversationType ?? "unknown",
		},
		sender: {
			id: input.senderId,
			displayName: input.senderName,
			trusted: input.trusted,
		},
		content: {
			text: input.text,
		},
		raw: input.raw,
	};
}

/**
 * How a file is shown, from its media type. SVG is a file, not an image:
 * chat clients that inline images rasterise PNG/JPEG/GIF/WebP, and an SVG
 * sent as one shows as a broken thumbnail (or runs as a document) instead.
 */
export function attachmentKind(mimeType: string): AttachmentKind {
	const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";

	if (type === "image/svg+xml") {
		return "file";
	}

	if (type.startsWith("image/")) {
		return "image";
	}

	if (type.startsWith("video/")) {
		return "video";
	}

	if (type.startsWith("audio/")) {
		return "audio";
	}

	return "file";
}

/**
 * A size as a person reads it: 812 B, 4.2 KB, 18 MB. In 1024s, as chat clients
 * and homeservers count: Synapse's default limit is 52,428,800 bytes, which
 * every Matrix client calls 50 MB, and a notice saying "52 MB" would read as
 * a different number from the one the server's own docs give.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = -1;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	const shown =
		value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value);
	return `${shown} ${units[unit]}`;
}

/**
 * What a channel says, in the conversation, when a file did not go through.
 * Said there rather than only logged: the person waiting for a screenshot is
 * reading the chat, not the gateway's log, and a file that silently never
 * arrives is indistinguishable from an agent that never sent one.
 */
export function attachmentNotice(
	attachment: Pick<ChannelAttachment, "name" | "size">,
	reason: string,
): string {
	return `⚠️ Could not send ${attachment.name} (${formatBytes(attachment.size)}): ${reason}`;
}

export function createMemoryOutboundSink() {
	const messages: ChannelOutboundMessage[] = [];

	return {
		messages,
		async send(message: ChannelOutboundMessage): Promise<ChannelAck> {
			const messageWithId = {
				...message,
				id: message.id ?? crypto.randomUUID(),
			};

			messages.push(messageWithId);

			return {
				ok: true,
				messageId: messageWithId.id,
			};
		},
	};
}

export function createConsoleLogger(scope: string): ChannelLogger {
	const write = (
		level: string,
		message: string,
		meta?: Record<string, unknown>,
	) => {
		const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
		console.error(`[${scope}] ${level} ${message}${suffix}`);
	};

	return {
		debug: (message, meta) => write("debug", message, meta),
		info: (message, meta) => write("info", message, meta),
		warn: (message, meta) => write("warn", message, meta),
		error: (message, meta) => write("error", message, meta),
	};
}
