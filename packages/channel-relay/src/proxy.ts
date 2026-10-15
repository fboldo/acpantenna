/**
 * The filtering ACP proxy between a remote ACP client (a browser, through a
 * relay) and the agent. To the browser it is the agent; to the agent it is
 * one more client of the connection's session. Whoever holds a pairing link
 * could otherwise run commands on this machine, so nothing passes through
 * as it is:
 *
 * - only the methods a chat needs are let through; anything else is
 *   "method not found";
 * - the connection stays on its session: `session/load`, `resume`, `prompt`
 *   and the rest are refused for any other id, and `session/list` shows
 *   only that one;
 * - `session/new` runs in the connection's directory with the configured
 *   MCP servers, whatever the browser asked for;
 * - the agent's `fs/*` and `terminal/*` requests never reach the browser:
 *   the gateway declines them itself;
 * - "always allow" becomes "allow once";
 * - the browser's JSON-RPC ids never reach the agent, nor the agent's the
 *   browser;
 * - streamed text is sent in batches on a fixed tick.
 */

import type { ChannelAcpConnection, ChannelLogger } from "@acpantenna/channel";

/** Methods a browser may call. Responses to the agent's requests are let through too. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
	"initialize",
	"session/list",
	"session/new",
	"session/load",
	"session/resume",
	"session/prompt",
	"session/cancel",
	"session/set_mode",
	"session/set_config_option",
]);

/** Methods that act on a session, and so must name the connection's. */
const SESSION_METHODS: ReadonlySet<string> = new Set([
	"session/load",
	"session/resume",
	"session/prompt",
	"session/cancel",
	"session/set_mode",
	"session/set_config_option",
]);

/** Session updates whose text is batched on the tick. */
const CHUNK_UPDATES: ReadonlySet<string> = new Set([
	"agent_message_chunk",
	"agent_thought_chunk",
	"user_message_chunk",
]);

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number;

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface AcpProxyOptions {
	connection: ChannelAcpConnection;
	/** Sends one JSON-RPC message to the browser. */
	send: (message: string) => void;
	/** The batching tick for streamed text, in ms. */
	coalesceMs: number;
	/** How long the browser has to answer the agent's question. */
	interactionTimeoutMs: number;
	logger?: ChannelLogger;
}

interface PendingRequest {
	method: string;
	params: unknown;
	resolve: (result: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingChunk {
	params: Record<string, unknown>;
	update: Record<string, unknown>;
	text: string;
}

export class AcpProxy {
	private readonly connection: ChannelAcpConnection;
	private readonly sendRaw: (message: string) => void;
	private readonly coalesceMs: number;
	private readonly interactionTimeoutMs: number;
	private readonly logger: ChannelLogger | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	/** Sessions with a browser's `session/prompt` still running. */
	private readonly prompting = new Map<string, number>();
	private nextId = 1;
	private chunk: PendingChunk | undefined;
	private tick: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(options: AcpProxyOptions) {
		this.connection = options.connection;
		this.sendRaw = options.send;
		this.coalesceMs = options.coalesceMs;
		this.interactionTimeoutMs = options.interactionTimeoutMs;
		this.logger = options.logger;
	}

	/** One JSON-RPC message from the browser. Resolves once it has been answered. */
	async receive(text: string): Promise<void> {
		if (this.closed) {
			return;
		}

		let message: unknown;

		try {
			message = JSON.parse(text);
		} catch {
			this.respondError(null, { code: PARSE_ERROR, message: "Parse error" });
			return;
		}

		if (!isRecord(message) || message.jsonrpc !== "2.0") {
			this.respondError(idOf(message), {
				code: INVALID_REQUEST,
				message: "Invalid request",
			});
			return;
		}

		if (typeof message.method === "string") {
			const id = isId(message.id) ? message.id : undefined;

			if (id === undefined) {
				await this.handleNotification(message.method, message.params);
				return;
			}

			await this.handleRequest(id, message.method, message.params);
			return;
		}

		if (isId(message.id) && ("result" in message || "error" in message)) {
			this.handleResponse(message);
			return;
		}

		this.respondError(idOf(message), {
			code: INVALID_REQUEST,
			message: "Invalid request",
		});
	}

	/** A notification from the agent about the connection's session. */
	notification(method: string, params: unknown): void {
		if (this.closed) {
			return;
		}

		if (method === "session/update" && this.batch(params)) {
			return;
		}

		this.out({ jsonrpc: "2.0", method, params });
	}

	/** A request from the agent: put to the browser, with its answer checked. */
	async request(method: string, params: unknown): Promise<unknown> {
		if (
			method !== "session/request_permission" &&
			method !== "elicitation/create"
		) {
			throw rpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
		}

		if (this.closed) {
			return refusal(method, params, "cancel");
		}

		const id = this.nextId++;
		const answer = await new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve(undefined);
			}, this.interactionTimeoutMs);

			this.pending.set(id, { method, params, resolve, timer });
			this.out({ jsonrpc: "2.0", id, method, params });
		});

		return method === "session/request_permission"
			? checkPermissionAnswer(params, answer)
			: checkElicitationAnswer(params, answer);
	}

	/**
	 * The browser is gone: questions waiting for it are answered for it, and
	 * a turn it started is cancelled, unless `cancelTurns` is false (a
	 * remembered browser came back as a new client, to watch that turn).
	 */
	close(options: { cancelTurns?: boolean } = {}): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		clearTimeout(this.tick);
		this.chunk = undefined;

		for (const sessionId of this.prompting.keys()) {
			if (options.cancelTurns === false) {
				break;
			}

			void this.connection
				.notify("session/cancel", { sessionId })
				.catch(() => undefined);
		}

		this.prompting.clear();

		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.resolve(undefined);
		}
	}

	private async handleNotification(
		method: string,
		params: unknown,
	): Promise<void> {
		if (method !== "session/cancel") {
			return;
		}

		if (!this.isBoundSession(params)) {
			return;
		}

		await this.connection.notify(method, params).catch((error) => {
			this.logger?.warn("Could not pass a cancel on.", {
				error: errorMessage(error),
			});
		});
	}

	private async handleRequest(
		id: JsonRpcId,
		method: string,
		params: unknown,
	): Promise<void> {
		if (!ALLOWED_METHODS.has(method)) {
			this.respondError(id, {
				code: METHOD_NOT_FOUND,
				message: `Method not found: ${method}`,
			});
			return;
		}

		if (SESSION_METHODS.has(method) && !this.isBoundSession(params)) {
			this.respondError(id, {
				code: INVALID_PARAMS,
				message: "Only this connection's session can be used.",
			});
			return;
		}

		try {
			this.respond(
				id,
				await this.call(method, params as Record<string, unknown>),
			);
		} catch (error) {
			this.respondError(id, toRpcError(error));
		}
	}

	private async call(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const connection = this.connection;

		switch (method) {
			case "initialize":
				return filteredInitialize(connection.initializeResult);
			case "session/list":
				return {
					sessions: [
						{ sessionId: connection.acpSessionId, cwd: connection.cwd },
					],
				};
			case "session/new":
				return await connection.newSession();
			case "session/load":
			case "session/resume":
				// The directory and MCP servers are the connection's, never the browser's.
				return await connection.request(method, {
					sessionId: connection.acpSessionId,
					cwd: connection.cwd,
					mcpServers: connection.mcpServers,
				});
			case "session/cancel":
				await connection.notify(method, params);
				return null;
			case "session/prompt":
				return await this.prompt(params);
			default:
				return await connection.request(method, params);
		}
	}

	private async prompt(params: Record<string, unknown>): Promise<unknown> {
		const sessionId = String(params.sessionId);

		this.prompting.set(sessionId, (this.prompting.get(sessionId) ?? 0) + 1);

		try {
			return await this.connection.request("session/prompt", params);
		} finally {
			const left = (this.prompting.get(sessionId) ?? 1) - 1;

			if (left > 0) {
				this.prompting.set(sessionId, left);
			} else {
				this.prompting.delete(sessionId);
			}
		}
	}

	private handleResponse(message: Record<string, unknown>): void {
		const id = message.id;
		const pending = typeof id === "number" ? this.pending.get(id) : undefined;

		if (!pending || typeof id !== "number") {
			return;
		}

		clearTimeout(pending.timer);
		this.pending.delete(id);
		pending.resolve("error" in message ? undefined : message.result);
	}

	private isBoundSession(params: unknown): boolean {
		return (
			isRecord(params) && params.sessionId === this.connection.acpSessionId
		);
	}

	/**
	 * Holds a text chunk for the tick, joined to the one before when it
	 * continues it. Returns false for an update that is not batched.
	 */
	private batch(params: unknown): boolean {
		if (!isRecord(params) || !isRecord(params.update) || "_meta" in params) {
			return false;
		}

		const update = params.update;
		const content = update.content;

		if (
			typeof update.sessionUpdate !== "string" ||
			!CHUNK_UPDATES.has(update.sessionUpdate) ||
			!isRecord(content) ||
			content.type !== "text" ||
			typeof content.text !== "string" ||
			Object.keys(content).some((key) => key !== "type" && key !== "text") ||
			"_meta" in update ||
			"_meta" in content
		) {
			return false;
		}

		const held = this.chunk;

		if (
			held &&
			held.params.sessionId === params.sessionId &&
			held.update.sessionUpdate === update.sessionUpdate &&
			held.update.messageId === update.messageId
		) {
			held.text += content.text;
			return true;
		}

		this.flush();
		this.chunk = { params, update, text: content.text };
		this.tick = setTimeout(() => this.flush(), this.coalesceMs);
		return true;
	}

	private flush(): void {
		clearTimeout(this.tick);
		this.tick = undefined;

		const held = this.chunk;

		if (!held) {
			return;
		}

		this.chunk = undefined;
		this.sendNow({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				...held.params,
				update: {
					...held.update,
					content: { ...(held.update.content as object), text: held.text },
				},
			},
		});
	}

	/** Sends a message, after any text held for the tick, so the order holds. */
	private out(message: Record<string, unknown>): void {
		this.flush();
		this.sendNow(message);
	}

	private sendNow(message: Record<string, unknown>): void {
		if (this.closed) {
			return;
		}

		try {
			this.sendRaw(JSON.stringify(message));
		} catch (error) {
			this.logger?.warn("Could not send to the browser.", {
				error: errorMessage(error),
			});
		}
	}

	private respond(id: JsonRpcId, result: unknown): void {
		this.out({ jsonrpc: "2.0", id, result: result ?? null });
	}

	private respondError(id: JsonRpcId | null, error: JsonRpcError): void {
		this.out({ jsonrpc: "2.0", id, error });
	}
}

/**
 * The `initialize` answer the browser gets: the agent's, keeping only what
 * the proxy lets through. No authentication methods, no MCP servers of the
 * browser's own, no fork, close or delete; `session/list` is answered here.
 */
export function filteredInitialize(result: unknown): Record<string, unknown> {
	const agent = isRecord(result) ? result : {};
	const capabilities = isRecord(agent.agentCapabilities)
		? agent.agentCapabilities
		: {};
	const sessionCapabilities = isRecord(capabilities.sessionCapabilities)
		? capabilities.sessionCapabilities
		: {};

	return {
		protocolVersion: agent.protocolVersion ?? 1,
		agentCapabilities: {
			loadSession: capabilities.loadSession === true,
			...(isRecord(capabilities.promptCapabilities)
				? { promptCapabilities: capabilities.promptCapabilities }
				: {}),
			mcpCapabilities: { http: false, sse: false },
			sessionCapabilities: {
				list: {},
				...(isRecord(sessionCapabilities.resume) ? { resume: {} } : {}),
			},
		},
		authMethods: [],
		...(isRecord(agent.agentInfo) ? { agentInfo: agent.agentInfo } : {}),
	};
}

interface PermissionOption {
	optionId: string;
	kind?: string;
}

function permissionOptions(params: unknown): PermissionOption[] {
	if (!isRecord(params) || !Array.isArray(params.options)) {
		return [];
	}

	return params.options.filter(
		(option): option is PermissionOption =>
			isRecord(option) && typeof option.optionId === "string",
	);
}

/**
 * The browser's answer to a permission request, made safe: only an option
 * the agent offered, and "allow once" in place of "allow always". Anything
 * else, or no answer, refuses.
 */
export function checkPermissionAnswer(
	params: unknown,
	answer: unknown,
): unknown {
	const options = permissionOptions(params);
	const outcome = isRecord(answer) ? answer.outcome : undefined;

	if (isRecord(outcome) && outcome.outcome === "cancelled") {
		return { outcome: { outcome: "cancelled" } };
	}

	const chosen =
		isRecord(outcome) && outcome.outcome === "selected"
			? options.find((option) => option.optionId === outcome.optionId)
			: undefined;

	if (!chosen) {
		return refusal("session/request_permission", params, "reject");
	}

	if (chosen.kind === "allow_always") {
		const once = options.find((option) => option.kind === "allow_once");

		return once
			? { outcome: { outcome: "selected", optionId: once.optionId } }
			: refusal("session/request_permission", params, "reject");
	}

	return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

/** The browser's answer to an elicitation, if it is one; else it declines. */
export function checkElicitationAnswer(
	_params: unknown,
	answer: unknown,
): unknown {
	if (!isRecord(answer)) {
		return { action: "decline" };
	}

	if (answer.action === "accept" && isRecord(answer.content)) {
		return { action: "accept", content: answer.content };
	}

	if (answer.action === "cancel") {
		return { action: "cancel" };
	}

	return { action: "decline" };
}

/**
 * What the agent gets when nobody answers: a permission refused (a reject
 * option, else cancelled), an elicitation declined or cancelled.
 */
export function refusal(
	method: string,
	params: unknown,
	how: "reject" | "cancel",
): unknown {
	if (method === "elicitation/create") {
		return { action: how === "cancel" ? "cancel" : "decline" };
	}

	const options = permissionOptions(params);
	const reject =
		options.find((option) => option.kind === "reject_once") ??
		options.find((option) => option.kind === "reject_always");

	return how === "reject" && reject
		? { outcome: { outcome: "selected", optionId: reject.optionId } }
		: { outcome: { outcome: "cancelled" } };
}

function toRpcError(error: unknown): JsonRpcError {
	if (
		isRecord(error) &&
		typeof error.code === "number" &&
		typeof error.message === "string"
	) {
		return {
			code: error.code,
			message: error.message,
			...(error.data === undefined ? {} : { data: error.data }),
		};
	}

	return { code: INTERNAL_ERROR, message: errorMessage(error) };
}

function rpcError(code: number, message: string): Error & JsonRpcError {
	return Object.assign(new Error(message), { code, message });
}

function idOf(message: unknown): JsonRpcId | null {
	return isRecord(message) && isId(message.id) ? message.id : null;
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
