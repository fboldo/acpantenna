import { fileURLToPath } from "node:url";
import {
	type ClientConnection,
	type ClientContext,
	type ContentBlock,
	type CreateElicitationResponse,
	client as createClientApp,
	type InitializeResponse,
	methods,
	type NewSessionResponse,
	ndJsonStream,
	PROTOCOL_VERSION,
	type PromptResponse,
	type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/** How long dispose() waits for the agent process to exit once killed. */
const AGENT_EXIT_WAIT_MS = 2_000;

export interface AcpClientCapabilities {
	fs?: {
		readTextFile?: boolean;
		writeTextFile?: boolean;
	};
	terminal?: boolean;
}

export interface AcpClientOptions {
	id: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	clientInfo?: {
		name: string;
		version: string;
		title?: string;
	};
	capabilities?: AcpClientCapabilities;
	/**
	 * Maximum size of a single newline-delimited stdout frame, in bytes. A frame
	 * larger than this (or an unterminated buffer that grows past it) is treated
	 * as a protocol error, guarding against an agent that floods stdout.
	 */
	maxFrameBytes?: number;
	/**
	 * Timeout for short request/response RPCs (initialize, session/new, etc.).
	 * Does not apply to `session/prompt`, whose turn can legitimately run for
	 * minutes. `0` disables the timeout.
	 */
	requestTimeoutMs?: number;
}

/** Default {@link AcpClientOptions.maxFrameBytes}: 1 MiB. */
export const DEFAULT_MAX_FRAME_BYTES = 1_000_000;

/** Default {@link AcpClientOptions.requestTimeoutMs}: 30 seconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Protocol payload types are sourced from the official ACP SDK so they track the
 * schema as the protocol evolves, instead of being hand-modeled here.
 */
export type AcpInitializeResult = InitializeResponse;
export type AcpSessionResult = NewSessionResponse;
export type AcpPromptResult = PromptResponse;

/** The latest ACP protocol version acpantenna speaks (from the SDK). */
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** Protocol versions acpantenna can negotiate. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [
	PROTOCOL_VERSION,
];

export interface AcpPromptCapabilities {
	image: boolean;
	audio: boolean;
	embeddedContext: boolean;
}

/**
 * The agent capabilities acpantenna gates features on, normalized from the
 * `agentCapabilities` block of an `initialize` response. `loadSession` is a
 * top-level boolean; resume/list/close/delete are presence-based objects under
 * `sessionCapabilities` in the ACP schema.
 */
export interface AcpAgentCapabilities {
	loadSession: boolean;
	resumeSession: boolean;
	forkSession: boolean;
	listSessions: boolean;
	closeSession: boolean;
	deleteSession: boolean;
	prompt: AcpPromptCapabilities;
}

export interface AcpSessionRequest {
	cwd: string;
	additionalDirectories?: string[];
	mcpServers?: unknown[];
}

export interface AcpPromptRequest {
	sessionId: string;
	prompt: ContentBlock[];
}

export type AcpSessionUpdateListener = (
	params: unknown,
) => void | Promise<void>;

/**
 * Handles an agent-initiated `session/request_permission`. Receives the raw
 * request params and returns the ACP permission response.
 */
export type PermissionRequestHandler = (
	params: unknown,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/**
 * Handles an agent-initiated `elicitation/create`. Receives the raw request
 * params and returns the ACP elicitation response (accept/decline/cancel).
 */
export type ElicitationRequestHandler = (
	params: unknown,
) => Promise<CreateElicitationResponse> | CreateElicitationResponse;

export type {
	CreateElicitationResponse,
	RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface AcpClient {
	connect(): Promise<void>;
	initialize(): Promise<AcpInitializeResult>;
	newSession(request: AcpSessionRequest): Promise<AcpSessionResult>;
	prompt(request: AcpPromptRequest): Promise<AcpPromptResult>;
	cancel(sessionId: string): Promise<void>;
	closeSession(sessionId: string): Promise<void>;
	authenticate(methodId: string): Promise<void>;
	loadSession?(sessionId: string, request: AcpSessionRequest): Promise<void>;
	resumeSession?(sessionId: string, request: AcpSessionRequest): Promise<void>;
	/** `session/fork`: a copy of the session under a new id, ready to prompt. */
	forkSession?(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<AcpSessionResult>;
	/** `session/set_mode`: switch the session to one of the agent's modes. */
	setSessionMode?(sessionId: string, modeId: string): Promise<void>;
	/**
	 * Any request, as given: for a proxy that passes a remote client's
	 * requests on. Rejects with the agent's JSON-RPC error when it answers
	 * with one.
	 */
	request?(method: string, params: unknown): Promise<unknown>;
	/** Any notification, as given. */
	notify?(method: string, params: unknown): Promise<void>;
	onSessionUpdate(listener: AcpSessionUpdateListener): () => void;
	onPermissionRequest?(handler: PermissionRequestHandler): () => void;
	onElicitation?(handler: ElicitationRequestHandler): () => void;
	dispose(): Promise<void>;
	/** Whether the agent process is running. A client without a process may omit it. */
	isAlive?(): boolean;
	/** Called when the agent process exits on its own (not on dispose). */
	onExit?(listener: () => void): () => void;
	getProtocolVersion?(): number | undefined;
	getInitializeResult?(): AcpInitializeResult | undefined;
	getAgentCapabilities?(): AcpAgentCapabilities | undefined;
	getAuthMethods?(): unknown[];
	supportsLoadSession?(): boolean;
	supportsResumeSession?(): boolean;
	supportsForkSession?(): boolean;
}

export class AcpError extends Error {
	public readonly code?: number;
	public readonly data?: unknown;

	public constructor(
		message: string,
		options: { code?: number; data?: unknown } = {},
	) {
		super(message);
		this.name = "AcpError";
		this.code = options.code;
		this.data = options.data;
	}
}

/**
 * Stdio ACP client. Wraps the official SDK's client connection over
 * newline-delimited JSON, and layers the operational concerns the gateway needs
 * that the SDK does not provide: subprocess spawn/lifecycle, stderr tailing for
 * error context, short-RPC timeouts, a stdout frame-size guard, and a
 * structured default-deny for permission requests.
 */
export class StdioAcpClient implements AcpClient {
	private process?: ReturnType<typeof Bun.spawn>;
	private connection?: ClientConnection;
	private context?: ClientContext;
	private readonly updateListeners = new Set<AcpSessionUpdateListener>();
	private readonly exitListeners = new Set<() => void>();
	private connected = false;
	private disposing = false;
	private stderrTail = "";
	private initializeResult?: InitializeResponse;
	private agentCapabilities?: AcpAgentCapabilities;
	private negotiatedProtocolVersion?: number;
	private permissionHandler?: PermissionRequestHandler;
	private elicitationHandler?: ElicitationRequestHandler;
	private readonly maxFrameBytes: number;
	private readonly requestTimeoutMs: number;

	public constructor(private readonly options: AcpClientOptions) {
		this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	public async connect(): Promise<void> {
		if (this.connected) {
			return;
		}

		const env: Record<string, string> = {};

		for (const [envName, envValue] of Object.entries(process.env)) {
			if (typeof envValue === "string") {
				env[envName] = envValue;
			}
		}

		Object.assign(env, this.options.env ?? {});

		const child = Bun.spawn({
			cmd: [this.options.command, ...(this.options.args ?? [])],
			cwd: this.options.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		this.process = child;
		this.connected = true;
		this.disposing = false;

		void this.readStderr(isReadableStream(child.stderr) ? child.stderr : null);
		void child.exited.then(() => {
			// A later connect() may already have replaced this process.
			if (this.process !== child) {
				return;
			}

			this.connected = false;
			this.context = undefined;

			if (!this.disposing) {
				for (const listener of this.exitListeners) {
					listener();
				}
			}
		});

		if (!isReadableStream(child.stdout)) {
			throw new AcpError("ACP process stdout is not a readable stream.");
		}

		const input = this.guardFrameSize(child.stdout);
		const output = this.createStdinSink(child.stdin);

		const app = createClientApp({
			name: this.options.clientInfo?.name ?? "acpantenna",
		})
			.onNotification(methods.client.session.update, (context) => {
				this.dispatchUpdate(context.params);
			})
			.onRequest(methods.client.session.requestPermission, (context) =>
				this.handlePermission(context.params),
			)
			.onRequest(methods.client.elicitation.create, (context) =>
				this.handleElicitation(context.params),
			);

		this.connection = app.connect(ndJsonStream(output, input));
		this.context = this.connection.agent;
	}

	public async initialize(): Promise<InitializeResponse> {
		await this.connect();

		const result = await this.sendRequest<InitializeResponse>(
			methods.agent.initialize,
			{
				protocolVersion: CLIENT_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: {
						readTextFile: this.options.capabilities?.fs?.readTextFile ?? false,
						writeTextFile:
							this.options.capabilities?.fs?.writeTextFile ?? false,
					},
					terminal: this.options.capabilities?.terminal ?? false,
					// Advertise form elicitation only when a handler is registered to
					// answer it.
					...(this.elicitationHandler ? { elicitation: { form: {} } } : {}),
				},
				clientInfo: this.options.clientInfo ?? {
					name: "acpantenna",
					title: "acpantenna",
					version: "0.0.0",
				},
			},
			this.requestTimeoutMs,
		);

		this.negotiatedProtocolVersion = negotiateProtocolVersion(
			result.protocolVersion,
		);
		this.initializeResult = result;
		this.agentCapabilities = parseAgentCapabilities(result);

		return result;
	}

	public getProtocolVersion(): number | undefined {
		return this.negotiatedProtocolVersion;
	}

	public getInitializeResult(): InitializeResponse | undefined {
		return this.initializeResult;
	}

	public getAgentCapabilities(): AcpAgentCapabilities | undefined {
		return this.agentCapabilities;
	}

	public getAuthMethods(): unknown[] {
		return this.initializeResult?.authMethods ?? [];
	}

	public supportsLoadSession(): boolean {
		return this.agentCapabilities?.loadSession ?? false;
	}

	public supportsResumeSession(): boolean {
		return this.agentCapabilities?.resumeSession ?? false;
	}

	public supportsForkSession(): boolean {
		return this.agentCapabilities?.forkSession ?? false;
	}

	public async newSession(
		request: AcpSessionRequest,
	): Promise<NewSessionResponse> {
		const params: Record<string, unknown> = {
			cwd: request.cwd,
			mcpServers: request.mcpServers ?? [],
		};

		if (request.additionalDirectories?.length) {
			params.additionalDirectories = request.additionalDirectories;
		}

		return await this.sendRequest<NewSessionResponse>(
			methods.agent.session.new,
			params,
			this.requestTimeoutMs,
		);
	}

	public async prompt(request: AcpPromptRequest): Promise<PromptResponse> {
		// No timeout: a prompt turn can legitimately run for minutes; its
		// completion signal is the returned stopReason.
		return await this.sendRequest<PromptResponse>(
			methods.agent.session.prompt,
			request,
			0,
		);
	}

	public async setSessionMode(
		sessionId: string,
		modeId: string,
	): Promise<void> {
		await this.sendRequest(
			methods.agent.session.setMode,
			{ sessionId, modeId },
			this.requestTimeoutMs,
		);
	}

	public async cancel(sessionId: string): Promise<void> {
		await this.requireContext().notify(methods.agent.session.cancel, {
			sessionId,
		});
	}

	public async closeSession(sessionId: string): Promise<void> {
		await this.sendRequest(
			methods.agent.session.close,
			{ sessionId },
			this.requestTimeoutMs,
		);
	}

	public async authenticate(methodId: string): Promise<void> {
		await this.sendRequest(
			methods.agent.authenticate,
			{ methodId },
			this.requestTimeoutMs,
		);
	}

	public async loadSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<void> {
		await this.sendRequest(
			methods.agent.session.load,
			{
				sessionId,
				cwd: request.cwd,
				mcpServers: request.mcpServers ?? [],
			},
			this.requestTimeoutMs,
		);
	}

	public async resumeSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<void> {
		await this.sendRequest(
			methods.agent.session.resume,
			{ sessionId, cwd: request.cwd },
			this.requestTimeoutMs,
		);
	}

	public async forkSession(
		sessionId: string,
		request: AcpSessionRequest,
	): Promise<NewSessionResponse> {
		return await this.sendRequest<NewSessionResponse>(
			methods.agent.session.fork,
			{
				sessionId,
				cwd: request.cwd,
				mcpServers: request.mcpServers ?? [],
			},
			this.requestTimeoutMs,
		);
	}

	public async request(method: string, params: unknown): Promise<unknown> {
		// A prompt's turn can run for minutes; everything else is short.
		return await this.sendRequest(
			method,
			params,
			method === methods.agent.session.prompt ? 0 : this.requestTimeoutMs,
		);
	}

	public async notify(method: string, params: unknown): Promise<void> {
		await this.requireContext().notify(method, params);
	}

	public onSessionUpdate(listener: AcpSessionUpdateListener): () => void {
		this.updateListeners.add(listener);

		return () => {
			this.updateListeners.delete(listener);
		};
	}

	public isAlive(): boolean {
		return this.connected;
	}

	public onExit(listener: () => void): () => void {
		this.exitListeners.add(listener);

		return () => {
			this.exitListeners.delete(listener);
		};
	}

	public onPermissionRequest(handler: PermissionRequestHandler): () => void {
		this.permissionHandler = handler;

		return () => {
			if (this.permissionHandler === handler) {
				this.permissionHandler = undefined;
			}
		};
	}

	public onElicitation(handler: ElicitationRequestHandler): () => void {
		this.elicitationHandler = handler;

		return () => {
			if (this.elicitationHandler === handler) {
				this.elicitationHandler = undefined;
			}
		};
	}

	public async dispose(): Promise<void> {
		this.disposing = true;
		this.connected = false;
		this.context = undefined;

		try {
			this.connection?.close();
		} catch {
			// Connection may already be closed.
		}

		this.connection = undefined;

		const child = this.process;

		try {
			child?.kill();
		} catch {
			// Process may already be gone.
		}

		// Gone before this returns, so nothing it holds open outlives the
		// caller (Windows will not remove a directory a process still uses).
		if (child) {
			await Promise.race([child.exited, Bun.sleep(AGENT_EXIT_WAIT_MS)]);
		}
	}

	private async sendRequest<T = unknown>(
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<T> {
		const context = this.requireContext();

		if (timeoutMs <= 0) {
			return await context.request<T>(method, params);
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(
					new AcpError(
						`ACP request "${method}" timed out after ${timeoutMs}ms.`,
						{ data: this.stderrTail },
					),
				);
			}, timeoutMs);
		});

		try {
			return await Promise.race([
				context.request<T>(method, params, {
					cancellationSignal: controller.signal,
				}),
				timeout,
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	private requireContext(): ClientContext {
		if (!this.context) {
			throw new AcpError("ACP client is not connected.");
		}

		return this.context;
	}

	private dispatchUpdate(params: unknown): void {
		for (const listener of this.updateListeners) {
			void listener(params);
		}
	}

	private async handlePermission(
		params: unknown,
	): Promise<RequestPermissionResponse> {
		// Delegate to the gateway's policy handler when registered; otherwise fall
		// back to a structured cancel (deny) so an unmanaged client never hangs the
		// agent.
		if (this.permissionHandler) {
			return await this.permissionHandler(params);
		}

		return { outcome: { outcome: "cancelled" } };
	}

	private async handleElicitation(
		params: unknown,
	): Promise<CreateElicitationResponse> {
		if (this.elicitationHandler) {
			return await this.elicitationHandler(params);
		}

		return { action: "decline" };
	}

	private guardFrameSize(
		input: ReadableStream<Uint8Array>,
	): ReadableStream<Uint8Array> {
		const maxFrameBytes = this.maxFrameBytes;
		const makeError = () => this.makeFrameError();
		let sinceNewline = 0;

		return input.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					for (const byte of chunk) {
						if (byte === 0x0a) {
							sinceNewline = 0;
						} else {
							sinceNewline += 1;

							if (sinceNewline > maxFrameBytes) {
								controller.error(makeError());
								return;
							}
						}
					}

					controller.enqueue(chunk);
				},
			}),
		);
	}

	private makeFrameError(): AcpError {
		return new AcpError(
			`ACP stdout frame exceeded the ${this.maxFrameBytes}-byte frame limit. ACP stdout must contain only newline-delimited JSON-RPC frames; write logs and diagnostics to stderr instead.`,
			{ data: this.stderrTail },
		);
	}

	private createStdinSink(stdin: unknown): WritableStream<Uint8Array> {
		if (isFileSink(stdin)) {
			const sink = stdin;

			return new WritableStream<Uint8Array>({
				async write(chunk) {
					sink.write(chunk);
					await sink.flush();
				},
				close() {
					sink.end();
				},
				abort() {
					sink.end();
				},
			});
		}

		if (hasGetWriter(stdin)) {
			return stdin;
		}

		throw new AcpError("ACP process stdin does not support writes.");
	}

	private async readStderr(
		stderr: ReadableStream<Uint8Array> | null,
	): Promise<void> {
		if (!stderr) {
			return;
		}

		const reader = stderr.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const result = await reader.read();

			if (result.done) {
				break;
			}

			this.stderrTail =
				`${this.stderrTail}${decoder.decode(result.value, { stream: true })}`.slice(
					-4000,
				);
		}
	}
}

/**
 * Validate the protocol version an agent selected in its `initialize` response.
 * The client advertises {@link CLIENT_PROTOCOL_VERSION}; anything acpantenna
 * cannot speak is a hard error rather than a silent mismatch.
 */
export function negotiateProtocolVersion(returned: unknown): number {
	if (typeof returned !== "number" || !Number.isInteger(returned)) {
		throw new AcpError(
			`Agent returned a non-integer ACP protocol version: ${JSON.stringify(returned)}.`,
		);
	}

	if (!SUPPORTED_PROTOCOL_VERSIONS.includes(returned)) {
		throw new AcpError(
			`Agent selected ACP protocol version ${returned}, but acpantenna supports ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
		);
	}

	return returned;
}

/**
 * Normalize the `agentCapabilities` block of an `initialize` response into the
 * flags acpantenna gates features on.
 */
export function parseAgentCapabilities(
	result: InitializeResponse,
): AcpAgentCapabilities {
	const capabilities = result.agentCapabilities;
	const session = capabilities?.sessionCapabilities;
	const prompt = capabilities?.promptCapabilities;

	return {
		loadSession: capabilities?.loadSession === true,
		resumeSession: session?.resume != null,
		forkSession: session?.fork != null,
		listSessions: session?.list != null,
		closeSession: session?.close != null,
		deleteSession: session?.delete != null,
		prompt: {
			image: prompt?.image === true,
			audio: prompt?.audio === true,
			embeddedContext: prompt?.embeddedContext === true,
		},
	};
}

/**
 * JSON-RPC error code an agent returns from `session/new` (or `session/load`)
 * when the client must authenticate first. Matches the SDK's
 * `RequestError.authRequired()`.
 */
export const AUTH_REQUIRED_ERROR_CODE = -32000;

/** Whether an error is the ACP "authentication required" error. */
export function isAuthRequiredError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === AUTH_REQUIRED_ERROR_CODE
	);
}

/** Extract the advertised auth method ids from an `initialize` response's `authMethods`. */
export function extractAuthMethodIds(authMethods: unknown[]): string[] {
	const ids: string[] = [];

	for (const method of authMethods) {
		if (isRecord(method) && typeof method.id === "string") {
			ids.push(method.id);
		}
	}

	return ids;
}

export function createTextPrompt(text: string): ContentBlock[] {
	return [{ type: "text", text }];
}

/**
 * The text of an `agent_message_chunk`, or `undefined` for any other update.
 * Thoughts are deliberately excluded: they are not part of the reply (see
 * {@link parseSessionUpdate}, which reports them separately).
 */
export function extractTextFromSessionUpdate(
	params: unknown,
): string | undefined {
	const update = parseSessionUpdate(params);

	return update?.kind === "message" ? update.text : undefined;
}

/** A tool call, as announced by `tool_call` or changed by `tool_call_update`. */
export interface AcpToolCallInfo {
	id: string;
	title?: string;
	kind?: string;
	status?: string;
}

/**
 * A `session/update`, reduced to what a gateway acts on. `final` is the
 * `_meta["acpantenna/push"].final` hint that a pushed message is complete; `pushId` is
 * its `_meta["acpantenna/push"].id`, when the agent gives one.
 */
export type AcpSessionUpdate =
	| {
			kind: "message";
			text: string;
			final: boolean;
			pushId?: string;
	  }
	| {
			kind: "attachment";
			attachment: AcpAttachment;
			final: boolean;
			pushId?: string;
	  }
	| { kind: "thought"; text: string }
	| { kind: "toolCall"; toolCall: AcpToolCallInfo; update: boolean }
	| { kind: "other"; sessionUpdate: string };

/** Normalize a `session/update` notification's params, or `undefined` if malformed. */
export function parseSessionUpdate(
	params: unknown,
): AcpSessionUpdate | undefined {
	if (!isRecord(params) || !isRecord(params.update)) {
		return undefined;
	}

	const update = params.update;
	const sessionUpdate =
		typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

	switch (sessionUpdate) {
		case "agent_message_chunk": {
			const push = pushMeta(params, update);
			const attachment = contentAttachment(update.content);

			if (attachment) {
				return {
					kind: "attachment",
					attachment,
					final: push?.final === true,
					...(typeof push?.id === "string" ? { pushId: push.id } : {}),
				};
			}

			const text = contentText(update.content) ?? linkText(update.content);

			if (text === undefined) {
				return { kind: "other", sessionUpdate };
			}

			return {
				kind: "message",
				text,
				final: push?.final === true,
				...(typeof push?.id === "string" ? { pushId: push.id } : {}),
			};
		}
		case "agent_thought_chunk": {
			const text = contentText(update.content);

			return text === undefined
				? { kind: "other", sessionUpdate }
				: { kind: "thought", text };
		}
		case "tool_call":
		case "tool_call_update": {
			if (typeof update.toolCallId !== "string") {
				return { kind: "other", sessionUpdate };
			}

			return {
				kind: "toolCall",
				update: sessionUpdate === "tool_call_update",
				toolCall: {
					id: update.toolCallId,
					...(typeof update.title === "string" ? { title: update.title } : {}),
					...(typeof update.kind === "string" ? { kind: update.kind } : {}),
					...(typeof update.status === "string"
						? { status: update.status }
						: {}),
				},
			};
		}
		default:
			return { kind: "other", sessionUpdate };
	}
}

/** `_meta["acpantenna/push"]` from the chunk, its content block, or the notification. */
function pushMeta(
	params: Record<string, unknown>,
	update: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const content = isRecord(update.content) ? update.content : undefined;

	for (const holder of [update, content, params]) {
		const meta = holder && isRecord(holder._meta) ? holder._meta : undefined;
		const push = meta?.["acpantenna/push"];

		if (isRecord(push)) {
			return push;
		}
	}

	return undefined;
}

/**
 * A file the agent sent in its reply. Its bytes are either carried in the
 * block (base64 `data`, or a resource's `text`) or on this machine (`path`,
 * from a `file://` resource link). The agent is a process the gateway
 * started, so a path it names is one the gateway can read.
 */
export interface AcpAttachment {
	name: string;
	mimeType?: string;
	/** Bytes, when the agent said; a path is measured again before sending. */
	size?: number;
	path?: string;
	/** Base64, as ACP carries binary content. */
	data?: string;
	text?: string;
}

/**
 * The file in a message chunk's content block, or undefined for text (and
 * for a link to something that is not a local file, which is text).
 *
 * The four shapes are ACP's ContentBlock variants that carry content rather
 * than words: `image` and `audio` with base64 `data`, an embedded `resource`
 * with a `blob` or `text`, and a `resource_link` to a `file://` URI.
 */
export function contentAttachment(content: unknown): AcpAttachment | undefined {
	if (!isRecord(content)) {
		return undefined;
	}

	const mimeType = stringOr(content.mimeType);

	switch (content.type) {
		case "image":
		case "audio": {
			if (typeof content.data !== "string") {
				return undefined;
			}

			const uri = stringOr(content.uri);
			return {
				name: nameFromUri(uri) ?? defaultName(content.type, mimeType),
				...(mimeType ? { mimeType } : {}),
				data: content.data,
			};
		}
		case "resource": {
			const resource = isRecord(content.resource)
				? content.resource
				: undefined;

			if (!resource) {
				return undefined;
			}

			const uri = stringOr(resource.uri);
			const type = stringOr(resource.mimeType);
			const name = nameFromUri(uri) ?? defaultName("file", type);

			if (typeof resource.blob === "string") {
				return {
					name,
					...(type ? { mimeType: type } : {}),
					data: resource.blob,
				};
			}

			if (typeof resource.text === "string") {
				return {
					name,
					...(type ? { mimeType: type } : {}),
					text: resource.text,
				};
			}

			return undefined;
		}
		case "resource_link": {
			const path = filePath(stringOr(content.uri));

			if (!path) {
				return undefined;
			}

			return {
				name:
					stringOr(content.name) ??
					nameFromUri(stringOr(content.uri)) ??
					defaultName("file", mimeType),
				...(mimeType ? { mimeType } : {}),
				...(typeof content.size === "number" ? { size: content.size } : {}),
				path,
			};
		}
		default:
			return undefined;
	}
}

/** A resource link to anything but a local file reads as a markdown link. */
function linkText(content: unknown): string | undefined {
	if (!isRecord(content) || content.type !== "resource_link") {
		return undefined;
	}

	const uri = stringOr(content.uri);

	if (!uri) {
		return undefined;
	}

	const label = stringOr(content.title) ?? stringOr(content.name) ?? uri;
	return `[${label}](${uri})`;
}

function filePath(uri: string | undefined): string | undefined {
	if (!uri?.startsWith("file://")) {
		return undefined;
	}

	try {
		// Not the URL's pathname: on Windows that is /C:/…, not a path.
		return fileURLToPath(uri) || undefined;
	} catch {
		return undefined;
	}
}

function nameFromUri(uri: string | undefined): string | undefined {
	if (!uri) {
		return undefined;
	}

	let path = uri;

	try {
		path = uri.startsWith("file://")
			? fileURLToPath(uri)
			: decodeURIComponent(new URL(uri).pathname);
	} catch {
		// Not a URL: a bare name or path is fine as it is.
	}

	const base = path.split(/[\\/]/).filter(Boolean).pop();
	return base || undefined;
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"audio/mpeg": "mp3",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"application/pdf": "pdf",
	"text/plain": "txt",
};

function defaultName(kind: string, mimeType: string | undefined): string {
	const base = kind === "image" ? "image" : kind === "audio" ? "audio" : "file";
	const ext = mimeType ? EXTENSIONS[mimeType.toLowerCase()] : undefined;
	return ext ? `${base}.${ext}` : base;
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function contentText(content: unknown): string | undefined {
	if (
		isRecord(content) &&
		content.type === "text" &&
		typeof content.text === "string"
	) {
		return content.text;
	}

	if (
		isRecord(content) &&
		isRecord(content.content) &&
		content.content.type === "text" &&
		typeof content.content.text === "string"
	) {
		return content.content.text;
	}

	return undefined;
}

function hasGetWriter(value: unknown): value is WritableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { getWriter?: unknown }).getWriter === "function"
	);
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { getReader?: unknown }).getReader === "function"
	);
}

interface BunFileSink {
	write(chunk: Uint8Array): number;
	flush(): number | Promise<number>;
	end(): void;
}

function isFileSink(value: unknown): value is BunFileSink {
	return (
		isRecord(value) &&
		typeof value.write === "function" &&
		typeof value.flush === "function" &&
		typeof value.end === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
