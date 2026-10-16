import { join } from "node:path";
import type {
	ChannelAck,
	ChannelAttachment,
	ChannelContext,
	ChannelHealth,
	ChannelInboundEvent,
	ChannelInteractionResponse,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import { attachmentNotice, createTextInboundEvent } from "@acpantenna/channel";
import {
	type ApiParams,
	describeTelegramError,
	TelegramApi,
	TelegramApiError,
} from "./api.ts";
import {
	DEFAULT_API_URL,
	DEFAULT_EDIT_INTERVAL_MS,
	type TelegramChannelConfig,
} from "./config.ts";
import { escapeHtml, splitMarkdown } from "./format.ts";
import {
	addressedText,
	type BotIdentity,
	type ConversationAddress,
	conversationOf,
	displayName,
	isSenderAllowed,
	parseConversationId,
} from "./inbound.ts";
import {
	answeredPrompt,
	answerFromCallback,
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	type PendingInteraction,
	parseCallbackData,
	type RenderedPrompt,
	renderInteraction,
} from "./interactions.ts";
import type { LiveMessageTransport, MessageContent } from "./live-message.ts";
import {
	DOCUMENT,
	isPhotoRefused,
	isTooLarge,
	type UploadMethod,
	uploadLimitProblem,
	uploadMethod,
} from "./media.ts";
import { OffsetStore } from "./offset-store.ts";
import { ChatOutbox, replyContent } from "./outbox.ts";
import {
	GROUP_PACE,
	PRIVATE_PACE,
	RateLimitedError,
	SendPacer,
	withRateLimitRetry,
} from "./rate-limit.ts";
import type {
	TelegramCallbackQuery,
	TelegramMessage,
	TelegramUpdate,
	TelegramUser,
} from "./types.ts";

const FIRST_SEND_DELAY_MS = 400;
/** Telegram allows about 20 messages a minute in a group, edits included. */
const GROUP_EDIT_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_SECONDS = 30;
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** A configuration (or bot state) the user has to change; never retried. */
export class TelegramSetupError extends Error {
	public override readonly name = "TelegramSetupError";
}

type HealthState = ChannelHealth["state"];

export interface TelegramRuntimeDeps {
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

interface PendingEntry {
	conversationId: string;
	pending: PendingInteraction;
	shown: RenderedPrompt;
}

/**
 * One bot: the token check, long-polling getUpdates, and the translation
 * between Telegram chats (and forum topics) and gateway conversations.
 */
export class TelegramRuntime {
	private readonly api: TelegramApi;
	private readonly sleep: (ms: number) => Promise<void>;
	private bot?: BotIdentity;
	private offset?: number;
	private startedAt = 0;
	private stopping = false;
	private healthState: HealthState = "starting";
	private healthMessage?: string;
	private poller?: Promise<void>;
	/** Ends the long poll, and the wait before a retry, when stop() is called. */
	private readonly abort = new AbortController();
	private readonly stopped = new Promise<void>((resolve) => {
		this.abort.signal.addEventListener("abort", () => resolve(), {
			once: true,
		});
	});
	private readonly outboxes = new Map<string, ChatOutbox>();
	private readonly pacers = new Map<number, SendPacer>();
	private readonly inboundChains = new Map<string, Promise<void>>();
	/** Pending prompts by their buttons' token. */
	private readonly pending = new Map<string, PendingEntry>();

	public constructor(
		private readonly config: TelegramChannelConfig,
		private readonly context: ChannelContext<unknown>,
		deps: TelegramRuntimeDeps = {},
	) {
		this.api = new TelegramApi({
			token: config.botToken,
			apiUrl: this.apiUrl,
			fetch: deps.fetch,
		});
		this.sleep = deps.sleep ?? unrefSleep;
	}

	private get apiUrl(): string {
		return this.config.apiUrl ?? DEFAULT_API_URL;
	}

	private get streaming(): boolean {
		const mode = this.config.delivery?.mode;
		return mode === "streamChunks" || mode === "debounceChunks";
	}

	private get stateDir(): string {
		return (
			this.context.stateDir ??
			join(".acpantenna", "channels", this.context.channelId)
		);
	}

	public health(): ChannelHealth {
		return {
			state: this.healthState,
			...(this.healthMessage ? { message: this.healthMessage } : {}),
			checkedAt: new Date().toISOString(),
		};
	}

	/**
	 * Check the token and start polling. A token Telegram rejects, or a bot
	 * with a webhook set, fails here; a Bot API that can't be reached is
	 * retried in the background while health() says so.
	 */
	public async start(): Promise<void> {
		this.startedAt = Date.now();
		this.offset = await new OffsetStore(this.stateDir).read();

		try {
			await this.connect();
		} catch (error) {
			if (error instanceof TelegramSetupError) {
				this.setHealth("stopped", error.message);
				throw error;
			}

			this.setHealth("degraded", describeTelegramError(error, this.apiUrl));
		}

		this.poller = this.pollLoop();
	}

	public async stop(): Promise<void> {
		this.stopping = true;
		this.abort.abort();
		await Promise.race([
			Promise.all([
				this.poller,
				...[...this.outboxes.values()].map((outbox) => outbox.endTurn()),
			]),
			Bun.sleep(5_000),
		]);
		this.setHealth("stopped");
	}

	/** Who the bot is, and that it can poll: no webhook in the way. */
	private async connect(): Promise<void> {
		try {
			const me = await this.api.call<TelegramUser>("getMe");
			this.bot = { id: me.id, username: me.username ?? "" };

			const webhook = await this.api.call<{ url?: string }>("getWebhookInfo");

			if (webhook.url) {
				throw new TelegramSetupError(
					`The bot has a webhook set (${webhook.url}), so it can't poll for updates. Remove it (deleteWebhook), or use another bot.`,
				);
			}
		} catch (error) {
			if (error instanceof TelegramApiError && error.errorCode === 401) {
				throw new TelegramSetupError(describeTelegramError(error, this.apiUrl));
			}

			throw error;
		}

		this.context.logger.info("Connected to Telegram.", {
			bot: `@${this.bot.username}`,
		});
	}

	private async pollLoop(): Promise<void> {
		let failures = 0;

		while (!this.stopping && this.healthState !== "stopped") {
			try {
				if (!this.bot) {
					await this.connect();
				}

				const updates = await this.api.call<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: this.offset,
						timeout: POLL_TIMEOUT_SECONDS,
						allowed_updates: ["message", "callback_query"],
					},
					{
						signal: this.abort.signal,
						timeoutMs: (POLL_TIMEOUT_SECONDS + 15) * 1000,
					},
				);

				failures = 0;
				this.setHealth("ready");
				await this.handleUpdates(updates);
			} catch (error) {
				if (this.stopping) {
					return;
				}

				if (
					error instanceof TelegramSetupError ||
					(error instanceof TelegramApiError && error.errorCode === 401)
				) {
					this.setHealth(
						"stopped",
						error instanceof TelegramSetupError
							? error.message
							: describeTelegramError(error, this.apiUrl),
					);
					return;
				}

				this.setHealth("degraded", describeTelegramError(error, this.apiUrl));
				const hinted =
					error instanceof TelegramApiError ? error.retryAfterMs : undefined;
				const delay =
					hinted ??
					RECONNECT_DELAYS_MS[
						Math.min(failures, RECONNECT_DELAYS_MS.length - 1)
					] ??
					60_000;
				failures += 1;
				await Promise.race([this.sleep(delay), this.stopped]);
			}
		}
	}

	/** Hand each update on, then confirm them all by storing the next offset. */
	public async handleUpdates(updates: TelegramUpdate[]): Promise<void> {
		if (updates.length === 0) {
			return;
		}

		for (const update of updates) {
			if (update.message) {
				const message = update.message;
				this.chainInbound(conversationOf(message).id, () =>
					this.onMessage(message),
				);
			} else if (update.callback_query) {
				const query = update.callback_query;
				const key = query.message
					? conversationOf(query.message).id
					: String(query.from.id);
				this.chainInbound(key, () => this.onCallbackQuery(query));
			}
		}

		this.offset = Math.max(...updates.map((update) => update.update_id)) + 1;

		try {
			await new OffsetStore(this.stateDir).write(this.offset);
		} catch (error) {
			this.context.logger.warn("Could not save the Telegram update offset.", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Inbound work for a conversation runs in arrival order. */
	private chainInbound(key: string, task: () => Promise<void>): void {
		const previous = this.inboundChains.get(key) ?? Promise.resolve();
		const next = previous.then(task).catch((error) => {
			this.context.logger.error("Could not handle a Telegram update.", {
				conversationId: key,
				error: describeTelegramError(error, this.apiUrl),
			});
		});
		this.inboundChains.set(key, next);
	}

	/** Wait for every update handed on so far (tests, shutdown). */
	public async idle(): Promise<void> {
		await Promise.all(this.inboundChains.values());
	}

	private async onMessage(message: TelegramMessage): Promise<void> {
		const bot = this.bot;
		const from = message.from;

		if (message.migrate_to_chat_id) {
			this.context.logger.warn(
				"A Telegram group became a supergroup, with a new chat id. Update the allowlist and default conversation if they name the old one.",
				{ from: message.chat.id, to: message.migrate_to_chat_id },
			);
			return;
		}

		if (
			!bot ||
			!from ||
			from.is_bot ||
			message.chat.type === "channel" ||
			// The backlog from before start is history, not something to answer.
			message.date * 1000 < this.startedAt - 1000
		) {
			return;
		}

		const conversation = conversationOf(message);
		const senderId = String(from.id);
		const allowed = isSenderAllowed(
			this.config.permissions?.inbound,
			senderId,
			conversation.id,
		);
		const { addressed, text } = addressedText(
			message,
			bot,
			this.config.requireMention ?? true,
		);

		if (!allowed) {
			// In a private chat, /start is how someone finds their own id, which
			// is what goes on the allowlist.
			if (message.chat.type === "private" && /^\/start\b/.test(text)) {
				this.context.logger.info(
					"A Telegram user not on the allowlist started the bot.",
					{ userId: senderId, name: displayName(from) },
				);
				await this.notice(
					conversation.id,
					`This bot only talks to people on its allowlist. Your Telegram user id is ${senderId}: to be let in, ask its owner to add it to permissions.inbound.allow.`,
				);
			} else if (addressed) {
				// The ids are what the allowlist takes; this is where to find them.
				this.context.logger.info(
					"Ignored a Telegram message from a sender not on the allowlist.",
					{ userId: senderId, conversationId: conversation.id },
				);
			}

			return;
		}

		const replyTo = message.reply_to_message?.message_id;
		const pending =
			(replyTo !== undefined
				? this.findPendingByMessage(conversation.id, replyTo)
				: undefined) ??
			(addressed ? this.latestPending(conversation.id) : undefined);
		const answer = pending ? answerFromText(pending.pending, text) : undefined;

		if (pending && answer) {
			await this.answer(pending, answer, {
				from,
				message,
				type: "message",
			});
			return;
		}

		if (!addressed) {
			return;
		}

		if (/^\/start\b/.test(text)) {
			await this.notice(
				conversation.id,
				"Connected. Write to talk to the agent; /new starts a new session, /cancel stops the current turn.",
			);
			return;
		}

		if (message.text === undefined && message.caption === undefined) {
			await this.notice(
				conversation.id,
				"I can only read text messages for now.",
			);
			return;
		}

		if (!text) {
			return;
		}

		// A new message ends the turn's live reply, so the next one starts
		// below the user's message.
		await this.outbox(conversation.id).endTurn();
		void this.typing(conversation.id);
		this.emit(
			createTextInboundEvent({
				id: `${message.chat.id}:${message.message_id}`,
				text,
				conversationId: conversation.id,
				conversationType: conversation.type,
				senderId,
				senderName: displayName(from),
				timestamp: new Date(message.date * 1000).toISOString(),
				raw: {
					chatId: message.chat.id,
					messageId: message.message_id,
					...(message.message_thread_id !== undefined
						? { threadId: message.message_thread_id }
						: {}),
				},
			}),
		);
	}

	private async onCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
		const data = query.data ?? "";
		const parsed = parseCallbackData(data);
		const conversationId = query.message
			? conversationOf(query.message).id
			: undefined;

		if (!parsed) {
			await this.answerCallback(query.id);
			return;
		}

		if (
			!isSenderAllowed(
				this.config.permissions?.inbound,
				String(query.from.id),
				conversationId,
			)
		) {
			await this.answerCallback(query.id, "You can't answer this.");
			return;
		}

		const entry = this.pending.get(parsed.token);

		if (!entry || entry.pending.expiresAt < Date.now()) {
			if (entry) {
				this.pending.delete(parsed.token);
			}

			await this.answerCallback(query.id, "This question has expired.");

			if (query.message) {
				// Take the buttons away, so nobody else taps them.
				await this.api
					.call("editMessageReplyMarkup", {
						chat_id: query.message.chat.id,
						message_id: query.message.message_id,
					})
					.catch(() => undefined);
			}

			return;
		}

		const answer = answerFromCallback(entry.pending, data);

		if (!answer) {
			await this.answerCallback(query.id);
			return;
		}

		await this.answerCallback(
			query.id,
			describeAnswer(entry.pending, answer).slice(0, 190),
		);
		await this.answer(entry, answer, {
			from: query.from,
			message: query.message,
			type: "reaction",
		});
	}

	private async answerCallback(id: string, text?: string): Promise<void> {
		await this.api
			.call("answerCallbackQuery", {
				callback_query_id: id,
				...(text ? { text } : {}),
			})
			.catch((error) => {
				this.context.logger.debug("Could not answer a button press.", {
					error: describeTelegramError(error, this.apiUrl),
				});
			});
	}

	/** Pass the answer on, and edit the prompt to show it, without its buttons. */
	private async answer(
		entry: PendingEntry,
		response: ChannelInteractionResponse,
		source: {
			from: TelegramUser;
			message?: TelegramMessage;
			type: "message" | "reaction";
		},
	): Promise<void> {
		const { from, message, type } = source;
		this.pending.delete(entry.pending.token);
		const inbound = createTextInboundEvent({
			text: "",
			conversationId: entry.conversationId,
			senderId: String(from.id),
			senderName: displayName(from),
			...(message
				? {
						raw: {
							chatId: message.chat.id,
							messageId: message.message_id,
						},
					}
				: {}),
		});
		inbound.interaction = response;
		inbound.type = type;
		this.emit(inbound);

		const messageId = entry.pending.messageId;
		const address = parseConversationId(entry.conversationId);

		if (messageId === undefined || !address) {
			return;
		}

		const edited = answeredPrompt(
			entry.shown,
			describeAnswer(entry.pending, response),
			displayName(from),
		);

		void this.outbox(entry.conversationId)
			.run(() => this.transport(address).edit(messageId, edited))
			.catch(() => undefined);
	}

	private findPendingByMessage(
		conversationId: string,
		messageId: number,
	): PendingEntry | undefined {
		return this.livePending(conversationId).find(
			(entry) => entry.pending.messageId === messageId,
		);
	}

	private latestPending(conversationId: string): PendingEntry | undefined {
		return this.livePending(conversationId).at(-1);
	}

	private livePending(conversationId: string): PendingEntry[] {
		const now = Date.now();
		const live: PendingEntry[] = [];

		for (const [token, entry] of this.pending) {
			if (entry.pending.expiresAt < now) {
				this.pending.delete(token);
			} else if (entry.conversationId === conversationId) {
				live.push(entry);
			}
		}

		return live;
	}

	/** Hand an event to the gateway without holding up the chat's inbound order. */
	private emit(event: ChannelInboundEvent): void {
		void Promise.resolve(this.context.emit(event)).catch((error) => {
			this.context.logger.error(
				"The gateway did not take a Telegram message.",
				{
					eventId: event.id,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		});
	}

	public async send(message: ChannelOutboundMessage): Promise<ChannelAck> {
		const address = parseConversationId(message.conversationId);

		if (!address) {
			return {
				ok: false,
				error: `"${message.conversationId}" is not a Telegram chat id (like 123456789, -1001234567890, or -1001234567890:42 for a forum topic).`,
			};
		}

		if (!this.bot) {
			return {
				ok: false,
				retryAfterMs: 5_000,
				error:
					this.healthMessage ?? "The Telegram channel is still connecting.",
			};
		}

		const conversationId = message.conversationId;
		const outbox = this.outbox(conversationId);

		try {
			if (message.interaction) {
				return await this.sendInteraction(
					conversationId,
					address,
					outbox,
					message,
				);
			}

			if (message.attachment) {
				return await this.sendAttachment(address, outbox, message.attachment);
			}

			if (message.event?.type === "toolCall") {
				outbox.toolCall(message.event.toolCall);
				return { ok: true, messageId: message.id };
			}

			if (message.event || !message.text) {
				// Thoughts are not shown; other events have nothing to render.
				return { ok: true, messageId: message.id };
			}

			if (message.origin === "turn" && this.streaming) {
				outbox.appendReply(message.text);
				return { ok: true, messageId: message.id };
			}

			const transport = this.transport(address);
			let messageId: number | undefined;

			for (const part of splitMarkdown(message.text)) {
				messageId = await outbox.post(() => transport.send(replyContent(part)));
			}

			return { ok: true, messageId: String(messageId) };
		} catch (error) {
			return this.failedAck(error);
		}
	}

	private async sendInteraction(
		conversationId: string,
		address: ConversationAddress,
		outbox: ChatOutbox,
		message: ChannelOutboundMessage,
	): Promise<ChannelAck> {
		const prompt = message.interaction;

		if (!prompt) {
			return { ok: true };
		}

		const timeoutSeconds =
			this.config.permissions?.interactionTimeoutSeconds ?? 120;
		const pending = createPendingInteraction(
			prompt,
			Date.now() + timeoutSeconds * 1000,
		);
		const shown = renderInteraction(message.text ?? "", pending);
		const messageId = await outbox.post(() =>
			this.transport(address).send(shown, shown.keyboard),
		);

		pending.messageId = messageId;
		this.pending.set(pending.token, { conversationId, pending, shown });
		return { ok: true, messageId: String(messageId) };
	}

	/**
	 * Upload a file and post it. A file Telegram will not take is not a
	 * delivery failure to retry: the chat is told why, and the send counts
	 * as done, because the person waiting has been answered.
	 */
	private async sendAttachment(
		address: ConversationAddress,
		outbox: ChatOutbox,
		attachment: ChannelAttachment,
	): Promise<ChannelAck> {
		const refuse = async (reason: string) => {
			this.context.logger.warn("A file was not sent to Telegram.", {
				chatId: address.chatId,
				name: attachment.name,
				size: attachment.size,
				reason,
			});
			const text = attachmentNotice(attachment, reason);
			const messageId = await outbox.post(() =>
				this.transport(address).send({ html: escapeHtml(text), text }),
			);
			return { ok: true, messageId: String(messageId) };
		};

		// Checked before the file is read: a 2 GB video is refused without
		// being loaded into memory first.
		const tooLarge = uploadLimitProblem(attachment.size);

		if (tooLarge) {
			return refuse(tooLarge);
		}

		const blob = attachment.data
			? new Blob([attachment.data as Uint8Array<ArrayBuffer>], {
					type: attachment.mimeType,
				})
			: Bun.file(attachment.path ?? "", { type: attachment.mimeType });
		const upload = (method: UploadMethod) =>
			this.call<TelegramMessage>(address, method.method, {
				...this.target(address),
				[method.field]: { blob, name: attachment.name },
			});

		try {
			const method = uploadMethod(attachment);
			const sent = await outbox.post(async () => {
				try {
					return await upload(method);
				} catch (error) {
					// An image Telegram won't take as a photo (too long and thin,
					// say) still goes, as a file.
					if (method !== DOCUMENT && isPhotoRefused(error)) {
						return await upload(DOCUMENT);
					}

					throw error;
				}
			});

			return { ok: true, messageId: String(sent.message_id) };
		} catch (error) {
			if (isTooLarge(error)) {
				return refuse("Telegram refused it as too large.");
			}

			return this.failedAck(error);
		}
	}

	private failedAck(error: unknown): ChannelAck {
		if (error instanceof RateLimitedError) {
			return {
				ok: false,
				retryAfterMs: error.retryAfterMs,
				error: error.message,
			};
		}

		const reason = describeTelegramError(error, this.apiUrl);

		// Client errors (blocked by the user, no such chat) will not get better
		// by retrying.
		if (
			error instanceof TelegramApiError &&
			error.errorCode >= 400 &&
			error.errorCode < 500
		) {
			const moved = error.parameters.migrate_to_chat_id;
			return {
				ok: false,
				error: moved
					? `${reason} The group's new chat id is ${moved}.`
					: reason,
			};
		}

		return { ok: false, retryAfterMs: 2_000, error: reason };
	}

	private async notice(conversationId: string, text: string): Promise<void> {
		const address = parseConversationId(conversationId);

		if (!address) {
			return;
		}

		try {
			await this.outbox(conversationId).post(() =>
				this.transport(address).send({ html: escapeHtml(text), text }),
			);
		} catch (error) {
			this.context.logger.warn("Could not send a notice.", {
				conversationId,
				error: describeTelegramError(error, this.apiUrl),
			});
		}
	}

	private async typing(conversationId: string): Promise<void> {
		const address = parseConversationId(conversationId);

		if (address) {
			await this.api
				.call("sendChatAction", { ...this.target(address), action: "typing" })
				.catch(() => undefined);
		}
	}

	/** `chat_id`, and the topic for a forum topic. */
	private target(address: ConversationAddress): ApiParams {
		return {
			chat_id: address.chatId,
			...(address.threadId !== undefined
				? { message_thread_id: address.threadId }
				: {}),
		};
	}

	/** A call that goes to a chat: paced to its limits, 429s waited out. */
	private async call<T>(
		address: ConversationAddress,
		method: string,
		params: ApiParams,
	): Promise<T> {
		return await withRateLimitRetry(
			async () => {
				const wait = this.pacer(address.chatId).reserve();

				if (wait > 0) {
					await this.sleep(wait);
				}

				// Not cut short by stop(): what is pending is still sent then.
				return await this.api.call<T>(method, params, { timeoutMs: 120_000 });
			},
			{
				sleep: this.sleep,
				onLimited: (waitMs) => {
					this.context.logger.info("Rate-limited by Telegram; waiting.", {
						chatId: address.chatId,
						waitMs,
					});
				},
			},
		);
	}

	private pacer(chatId: number): SendPacer {
		let pacer = this.pacers.get(chatId);

		if (!pacer) {
			// Private chats have positive ids, groups negative ones.
			pacer = new SendPacer(chatId > 0 ? PRIVATE_PACE : GROUP_PACE);
			this.pacers.set(chatId, pacer);
		}

		return pacer;
	}

	private transport(address: ConversationAddress): LiveMessageTransport {
		const withFallback = async <T>(
			method: string,
			content: MessageContent,
			params: ApiParams,
		): Promise<T> => {
			try {
				return await this.call<T>(address, method, {
					...params,
					text: content.html,
					parse_mode: "HTML",
				});
			} catch (error) {
				if (!isParseError(error)) {
					throw error;
				}

				// Should the HTML ever not parse, the words still get there.
				this.context.logger.warn(
					"Telegram could not parse a message's HTML; sent it as plain text.",
					{ error: describeTelegramError(error, this.apiUrl) },
				);
				return await this.call<T>(address, method, {
					...params,
					text: content.text,
				});
			}
		};

		return {
			send: async (content, keyboard) => {
				const sent = await withFallback<TelegramMessage>(
					"sendMessage",
					content,
					{
						...this.target(address),
						link_preview_options: { is_disabled: true },
						...(keyboard ? { reply_markup: keyboard } : {}),
					},
				);
				return sent.message_id;
			},
			edit: async (messageId, content) => {
				try {
					await withFallback("editMessageText", content, {
						chat_id: address.chatId,
						message_id: messageId,
						link_preview_options: { is_disabled: true },
					});
				} catch (error) {
					if (!isNotModified(error)) {
						throw error;
					}
				}
			},
		};
	}

	private outbox(conversationId: string): ChatOutbox {
		let outbox = this.outboxes.get(conversationId);

		if (!outbox) {
			const address = parseConversationId(conversationId);
			const configured = this.config.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
			const isPrivate = (address?.chatId ?? 0) > 0;

			outbox = new ChatOutbox({
				transport: address
					? this.transport(address)
					: {
							send: () => Promise.reject(new Error("Not a chat.")),
							edit: () => Promise.reject(new Error("Not a chat.")),
						},
				firstSendDelayMs: FIRST_SEND_DELAY_MS,
				editIntervalMs: isPrivate
					? configured
					: Math.max(configured, GROUP_EDIT_INTERVAL_MS),
				onError: (error) => {
					this.context.logger.warn("Could not update a Telegram message.", {
						conversationId,
						error: describeTelegramError(error, this.apiUrl),
					});
				},
			});
			this.outboxes.set(conversationId, outbox);
		}

		return outbox;
	}

	private setHealth(state: HealthState, message?: string): void {
		if (state !== this.healthState || message !== this.healthMessage) {
			const log = state === "ready" ? "info" : "warn";
			this.context.logger[log](
				`Telegram channel ${state}.`,
				message ? { reason: message } : undefined,
			);
		}

		this.healthState = state;
		this.healthMessage = message;
	}
}

/** A wait that does not keep the process alive by itself. */
function unrefSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		(timer as { unref?: () => void }).unref?.();
	});
}

/** Telegram could not read the HTML (`can't parse entities`). */
export function isParseError(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		error.errorCode === 400 &&
		/can't parse entities|unsupported start tag|can't find end/i.test(
			error.description,
		)
	);
}

/** An edit to what the message already says, which Telegram refuses. */
export function isNotModified(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		error.errorCode === 400 &&
		/message is not modified/i.test(error.description)
	);
}
