#!/usr/bin/env bun

/// <reference types="bun" />

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

interface DumbClientOptions {
	responsePrefix: string;
	loadSession: boolean;
	resume: boolean;
	list: boolean;
	close: boolean;
	authMethodId?: string;
	stopReason: acp.StopReason;
	elicit: boolean;
	/** Offer `ask`/`trusted` modes, honour `session/set_mode`, and prefix replies with the mode. */
	modes: boolean;
	/** Send a thought, a tool call and its completion before each reply. */
	thoughtsAndTools: boolean;
	/** After each turn, push this text between turns (two chunks, the last marked final). */
	pushAfterTurn?: string;
	/** After each turn, ask a permission between turns, then push the outcome. */
	pushPermission: boolean;
	/** Shortly after a `session/load`, push this text to the loaded session. */
	pushOnLoad?: string;
	/** Replay a short history as updates during `session/load`, as the spec says. */
	replay: boolean;
	/** Say "waiting for /cancel", then hold each prompt open until it is cancelled. */
	waitForCancel: boolean;
	/** Prefix replies with the session id and its directory: `[<id> <cwd>] `. */
	echoContext: boolean;
	/** Offer `session/fork`. */
	fork: boolean;
	/** Ask a permission in each turn, offering allow once, allow always and reject; say the outcome. */
	askPermission: boolean;
	/** Ask the client to read this file in each turn (`fs/read_text_file`); say how it went. */
	readFile?: string;
	/** Prefix replies with the names of the session's MCP servers: `[mcp: a,b] `. */
	echoMcp: boolean;
}

interface DumbSession {
	pendingPrompt: AbortController | null;
	mode: string;
	cwd: string;
	mcpServers?: string[];
}

function mcpNames(servers: unknown): string[] {
	return Array.isArray(servers)
		? servers.map((server) => String((server as { name?: unknown }).name))
		: [];
}

const MODES: acp.SessionMode[] = [
	{ id: "ask", name: "Ask" },
	{ id: "trusted", name: "Trusted" },
];

class DumbAcpAgent {
	private readonly sessions = new Map<string, DumbSession>();
	private nextSessionNumber = 1;
	private authenticated = false;

	public constructor(private readonly options: DumbClientOptions) {}

	public initialize(_params: acp.InitializeRequest): acp.InitializeResponse {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: this.options.loadSession,
				sessionCapabilities: {
					resume: this.options.resume ? {} : null,
					fork: this.options.fork ? {} : null,
					list: this.options.list ? {} : null,
					close: this.options.close ? {} : null,
				},
			},
			authMethods: this.options.authMethodId
				? [{ id: this.options.authMethodId, name: "Test auth" }]
				: [],
			agentInfo: {
				name: "acpantenna-dumb-client",
				title: "acpantenna dumb client",
				version: "0.0.0",
			},
		};
	}

	public authenticate(
		params: acp.AuthenticateRequest,
	): acp.AuthenticateResponse {
		if (params.methodId === this.options.authMethodId) {
			this.authenticated = true;
		}

		return {};
	}

	public async loadSession(
		params: acp.LoadSessionRequest,
		client: acp.AgentContext,
	): Promise<acp.LoadSessionResponse> {
		// A real agent would restore persisted state; the stub just (re-)registers
		// the id so subsequent prompts succeed.
		this.sessions.set(params.sessionId, {
			pendingPrompt: null,
			mode: "ask",
			cwd: params.cwd,
			mcpServers: mcpNames(params.mcpServers),
		});

		if (this.options.replay) {
			// The spec has the agent replay the conversation before answering.
			await sendText(
				client,
				params.sessionId,
				"user_message_chunk",
				"old question",
			);
			await sendText(
				client,
				params.sessionId,
				"agent_message_chunk",
				"old answer",
			);
		}

		const pushOnLoad = this.options.pushOnLoad;

		if (pushOnLoad) {
			setTimeout(() => {
				void sendText(
					client,
					params.sessionId,
					"agent_message_chunk",
					finalPush(pushOnLoad),
				);
			}, 50);
		}

		return this.options.modes ? { modes: modeState("ask") } : {};
	}

	public resumeSession(
		params: acp.ResumeSessionRequest,
	): acp.ResumeSessionResponse {
		this.sessions.set(params.sessionId, {
			pendingPrompt: null,
			mode: "ask",
			cwd: params.cwd,
			mcpServers: mcpNames((params as { mcpServers?: unknown }).mcpServers),
		});

		return {};
	}

	public forkSession(params: acp.ForkSessionRequest): acp.ForkSessionResponse {
		const sessionId = `${params.sessionId}-fork-${this.nextSessionNumber}`;
		this.nextSessionNumber += 1;
		this.sessions.set(sessionId, {
			pendingPrompt: null,
			mode: "ask",
			cwd: params.cwd,
		});

		return { sessionId };
	}

	public async setSessionMode(
		params: acp.SetSessionModeRequest,
		client: acp.AgentContext,
	): Promise<acp.SetSessionModeResponse> {
		const session = this.sessions.get(params.sessionId);

		if (!session) {
			throw acp.RequestError.resourceNotFound(params.sessionId);
		}

		if (!MODES.some((mode) => mode.id === params.modeId)) {
			throw acp.RequestError.invalidParams(
				{ modeId: params.modeId },
				"unknown mode",
			);
		}

		session.mode = params.modeId;
		await client.notify(acp.methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "current_mode_update",
				currentModeId: params.modeId,
			},
		});

		return {};
	}

	public newSession(params: acp.NewSessionRequest): acp.NewSessionResponse {
		if (this.options.authMethodId && !this.authenticated) {
			throw acp.RequestError.authRequired();
		}

		const sessionId = `dumb-session-${this.nextSessionNumber}`;
		this.nextSessionNumber += 1;
		this.sessions.set(sessionId, {
			pendingPrompt: null,
			mode: "ask",
			cwd: params.cwd,
			mcpServers: mcpNames(params.mcpServers),
		});

		return {
			sessionId,
			configOptions: [],
			...(this.options.modes ? { modes: modeState("ask") } : {}),
		};
	}

	public async prompt(
		params: acp.PromptRequest,
		client: acp.AgentContext,
	): Promise<acp.PromptResponse> {
		const session = this.sessions.get(params.sessionId);

		if (!session) {
			throw new Error(`Session ${params.sessionId} not found.`);
		}

		session.pendingPrompt?.abort();
		session.pendingPrompt = new AbortController();

		if (session.pendingPrompt.signal.aborted) {
			return { stopReason: "cancelled" };
		}

		if (this.options.waitForCancel) {
			const signal = session.pendingPrompt.signal;

			// Say so, so a client can tell the turn is in flight before it cancels.
			await sendText(
				client,
				params.sessionId,
				"agent_message_chunk",
				"waiting for /cancel",
			);

			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			session.pendingPrompt = null;

			return { stopReason: "cancelled" };
		}

		const modePrefix = this.options.modes ? `[${session.mode}] ` : "";
		const mcpPrefix = this.options.echoMcp
			? `[mcp: ${(session.mcpServers ?? []).join(",")}] `
			: "";
		const contextPrefix = this.options.echoContext
			? `[${params.sessionId} ${session.cwd}] `
			: "";
		let text = `${contextPrefix}${mcpPrefix}${modePrefix}${this.options.responsePrefix}${extractPromptText(params.prompt) ?? ""}`;

		if (this.options.askPermission) {
			const answer = await client.request(
				acp.methods.client.session.requestPermission,
				{
					sessionId: params.sessionId,
					toolCall: {
						toolCallId: "write-1",
						title: "Write a file",
						kind: "edit",
						status: "pending",
					},
					options: [
						{ optionId: "once", name: "Allow once", kind: "allow_once" },
						{ optionId: "always", name: "Always allow", kind: "allow_always" },
						{ optionId: "no", name: "Reject", kind: "reject_once" },
					],
				},
			);

			text += ` [permission: ${
				answer.outcome.outcome === "selected"
					? answer.outcome.optionId
					: answer.outcome.outcome
			}]`;
		}

		if (this.options.readFile) {
			try {
				await client.request(acp.methods.client.fs.readTextFile, {
					sessionId: params.sessionId,
					path: this.options.readFile,
				});
				text += " [fs: read]";
			} catch (error) {
				text += ` [fs: refused ${(error as { code?: number }).code ?? "?"}]`;
			}
		}

		if (this.options.thoughtsAndTools) {
			await sendText(
				client,
				params.sessionId,
				"agent_thought_chunk",
				"thinking it over",
			);
			await client.notify(acp.methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "tool-1",
					title: "dumb.lookup",
					kind: "read",
					status: "pending",
				},
			});
			await client.notify(acp.methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId: "tool-1",
					status: "completed",
				},
			});
		}

		if (this.options.elicit) {
			// Ask the client for structured input mid-turn and echo the outcome so
			// the round-trip is observable from a session update.
			const elicited = await client.request(
				acp.methods.client.elicitation.create,
				{
					mode: "form",
					sessionId: params.sessionId,
					message: "What is your name?",
					requestedSchema: {
						type: "object",
						properties: { name: { type: "string" } },
						required: ["name"],
					},
				},
			);

			text += ` [elicited ${elicited.action}: ${JSON.stringify(
				elicited.action === "accept" ? (elicited.content ?? null) : null,
			)}]`;
		}

		await client.notify(acp.methods.client.session.update, {
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text,
				},
			},
		});

		// `attach <path>` also sends that file, as an agent pushing a file sends one: a resource
		// link to a local path, for a gateway to upload.
		const attach = /^attach (\S+)/.exec(extractPromptText(params.prompt) ?? "");

		if (attach?.[1]) {
			await client.notify(acp.methods.client.session.update, {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "resource_link",
						uri: `file://${attach[1]}`,
						name: attach[1].split("/").pop() ?? "file",
					},
				},
			});
		}

		session.pendingPrompt = null;
		this.schedulePushes(params.sessionId, client);

		return { stopReason: this.options.stopReason };
	}

	/** Out-of-turn traffic, sent once the turn's response is on the wire. */
	private schedulePushes(sessionId: string, client: acp.AgentContext): void {
		const pushAfterTurn = this.options.pushAfterTurn;

		if (pushAfterTurn) {
			const middle = Math.ceil(pushAfterTurn.length / 2);

			setTimeout(async () => {
				await sendText(
					client,
					sessionId,
					"agent_message_chunk",
					pushAfterTurn.slice(0, middle),
				);
				await sendText(
					client,
					sessionId,
					"agent_message_chunk",
					finalPush(pushAfterTurn.slice(middle)),
				);
			}, 20);
		}

		if (this.options.pushPermission) {
			setTimeout(async () => {
				const answer = await client.request(
					acp.methods.client.session.requestPermission,
					{
						sessionId,
						toolCall: {
							toolCallId: "question-1",
							title: "Ship it?",
							kind: "other",
							status: "pending",
						},
						options: [
							{ optionId: "yes", name: "Yes", kind: "allow_once" },
							{ optionId: "no", name: "No", kind: "reject_once" },
						],
					},
				);
				const outcome =
					answer.outcome.outcome === "selected"
						? answer.outcome.optionId
						: answer.outcome.outcome;

				await sendText(
					client,
					sessionId,
					"agent_message_chunk",
					finalPush(`permission outcome: ${outcome}`),
				);
			}, 20);
		}
	}

	public closeSession(
		params: acp.CloseSessionRequest,
	): acp.CloseSessionResponse {
		this.sessions.delete(params.sessionId);

		return {};
	}

	public cancel(params: acp.CancelNotification): void {
		this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
	}
}

const options = parseOptions(process.argv.slice(2));
const dumbAgent = new DumbAcpAgent(options);
const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(
	process.stdin,
) as unknown as ReadableStream<Uint8Array>;

acp
	.agent({ name: "acpantenna-dumb-client" })
	.onRequest(acp.methods.agent.initialize, (context) =>
		dumbAgent.initialize(context.params),
	)
	.onRequest(acp.methods.agent.authenticate, (context) =>
		dumbAgent.authenticate(context.params),
	)
	.onRequest(acp.methods.agent.session.new, (context) =>
		dumbAgent.newSession(context.params),
	)
	.onRequest(acp.methods.agent.session.load, (context) =>
		dumbAgent.loadSession(context.params, context.client),
	)
	.onRequest(acp.methods.agent.session.setMode, (context) =>
		dumbAgent.setSessionMode(context.params, context.client),
	)
	.onRequest(acp.methods.agent.session.resume, (context) =>
		dumbAgent.resumeSession(context.params),
	)
	.onRequest(acp.methods.agent.session.fork, (context) =>
		dumbAgent.forkSession(context.params),
	)
	.onRequest(acp.methods.agent.session.prompt, (context) =>
		dumbAgent.prompt(context.params, context.client),
	)
	.onRequest(acp.methods.agent.session.close, (context) =>
		dumbAgent.closeSession(context.params),
	)
	.onNotification(acp.methods.agent.session.cancel, (context) =>
		dumbAgent.cancel(context.params),
	)
	.connect(acp.ndJsonStream(output, input));

function modeState(currentModeId: string): acp.SessionModeState {
	return { currentModeId, availableModes: MODES };
}

/** A chunk marked as the last chunk of a pushed message. */
function finalPush(text: string): {
	text: string;
	meta: Record<string, unknown>;
} {
	return { text, meta: { "acpantenna/push": { final: true } } };
}

async function sendText(
	client: acp.AgentContext,
	sessionId: string,
	sessionUpdate:
		| "agent_message_chunk"
		| "agent_thought_chunk"
		| "user_message_chunk",
	chunk: string | { text: string; meta: Record<string, unknown> },
): Promise<void> {
	const { text, meta } =
		typeof chunk === "string" ? { text: chunk, meta: undefined } : chunk;

	await client.notify(acp.methods.client.session.update, {
		sessionId,
		update: {
			sessionUpdate,
			content: { type: "text", text },
			...(meta ? { _meta: meta } : {}),
		},
	});
}

function extractPromptText(
	prompt: acp.PromptRequest["prompt"],
): string | undefined {
	const textParts = prompt.flatMap((part) => extractTextParts(part));

	return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractTextParts(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((item) => extractTextParts(item));
	}

	if (!isRecord(value)) {
		return [];
	}

	const textParts: string[] = [];

	if (value.type === "text" && typeof value.text === "string") {
		textParts.push(value.text);
	}

	if ("content" in value) {
		textParts.push(...extractTextParts(value.content));
	}

	return textParts;
}

function parseOptions(argv: string[]): DumbClientOptions {
	let responsePrefix = "dumb client: ";
	let loadSession = false;
	let resume = false;
	let list = false;
	let close = false;
	let authMethodId: string | undefined;
	let stopReason: acp.StopReason = "end_turn";
	let elicit = false;
	let modes = false;
	let thoughtsAndTools = false;
	let pushAfterTurn: string | undefined;
	let pushPermission = false;
	let pushOnLoad: string | undefined;
	let replay = false;
	let waitForCancel = false;
	let echoContext = false;
	let fork = false;
	let askPermission = false;
	let readFile: string | undefined;
	let echoMcp = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === "--response-prefix") {
			responsePrefix = argv[index + 1] ?? responsePrefix;
			index += 1;
		} else if (arg === "--load-session") {
			loadSession = true;
		} else if (arg === "--resume") {
			resume = true;
		} else if (arg === "--list-sessions") {
			list = true;
		} else if (arg === "--close-sessions") {
			close = true;
		} else if (arg === "--auth-method") {
			authMethodId = argv[index + 1] ?? authMethodId;
			index += 1;
		} else if (arg === "--stop-reason") {
			stopReason = (argv[index + 1] as acp.StopReason) ?? stopReason;
			index += 1;
		} else if (arg === "--elicit") {
			elicit = true;
		} else if (arg === "--modes") {
			modes = true;
		} else if (arg === "--thoughts-and-tools") {
			thoughtsAndTools = true;
		} else if (arg === "--push-after-turn") {
			pushAfterTurn = argv[index + 1];
			index += 1;
		} else if (arg === "--push-permission") {
			pushPermission = true;
		} else if (arg === "--push-on-load") {
			pushOnLoad = argv[index + 1];
			index += 1;
		} else if (arg === "--replay") {
			replay = true;
		} else if (arg === "--wait-for-cancel") {
			waitForCancel = true;
		} else if (arg === "--echo-context") {
			echoContext = true;
		} else if (arg === "--fork") {
			fork = true;
		} else if (arg === "--ask-permission") {
			askPermission = true;
		} else if (arg === "--read-file") {
			readFile = argv[index + 1];
			index += 1;
		} else if (arg === "--echo-mcp") {
			echoMcp = true;
		}
	}

	return {
		responsePrefix,
		loadSession,
		resume,
		list,
		close,
		authMethodId,
		stopReason,
		elicit,
		modes,
		thoughtsAndTools,
		pushAfterTurn,
		pushPermission,
		pushOnLoad,
		replay,
		waitForCancel,
		echoContext,
		fork,
		askPermission,
		readFile,
		echoMcp,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
