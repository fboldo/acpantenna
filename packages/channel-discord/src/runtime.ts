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
	DEFAULT_EDIT_INTERVAL_MS,
	DEFAULT_MAX_UPLOAD_BYTES,
	type DiscordChannelConfig,
	normalizeToken,
} from "./config.ts";
import { DiscordSetupError } from "./errors.ts";
import { NO_MENTIONS, splitMessage } from "./format.ts";
import {
	DEFAULT_GATEWAY_URL,
	DiscordGateway,
	type SocketFactory,
} from "./gateway.ts";
import {
	conversationType,
	describeDiscordError,
	isSenderAllowed,
	isThread,
	isUserMessageType,
	type MessagePlace,
	mentionsBot,
	parentIds,
	stripBotMention,
} from "./inbound.ts";
import {
	answeredContent,
	answerFromComponent,
	answerFromModal,
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	expiredContent,
	formModal,
	modalValues,
	type PendingInteraction,
	parseCustomId,
	renderInteraction,
} from "./interactions.ts";
import type { LiveMessageTransport, MessageContent } from "./live-message.ts";
import { isTooLarge, uploadForm, uploadLimitProblem } from "./media.ts";
import { ChannelOutbox } from "./outbox.ts";
import { RateLimitedError } from "./rate-limit.ts";
import { DiscordApiError, DiscordRest } from "./rest.ts";

const FIRST_SEND_DELAY_MS = 400;
const PROCESSED_MEMORY = 500;

/** Message flags: no link previews, and no push notification. */
const SUPPRESS_EMBEDS = 1 << 2;
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const EPHEMERAL = 1 << 6;

/** Interaction types and the callback types that answer them. */
const InteractionType = { MessageComponent: 3, ModalSubmit: 5 };
const Callback = {
	Message: 4,
	DeferredUpdate: 6,
	UpdateMessage: 7,
	Modal: 9,
};

export { DiscordSetupError };

type HealthState = ChannelHealth["state"];

/** The network, replaceable in tests. */
export interface DiscordRuntimeDeps {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	createSocket?: SocketFactory;
}

interface DiscordUser {
	id: string;
	username?: string;
	global_name?: string | null;
	bot?: boolean;
}

interface DiscordMessage {
	id: string;
	channel_id: string;
	guild_id?: string;
	type?: number;
	content?: string;
	author: DiscordUser;
	member?: { nick?: string | null };
	mentions?: DiscordUser[];
	attachments?: unknown[];
	webhook_id?: string;
	timestamp?: string;
	message_reference?: { message_id?: string };
}

interface DiscordChannel {
	id: string;
	type?: number;
	guild_id?: string;
	parent_id?: string | null;
	name?: string;
}

interface DiscordInteraction {
	id: string;
	type: number;
	token: string;
	channel_id?: string;
	guild_id?: string;
	channel?: DiscordChannel;
	member?: { user?: DiscordUser; nick?: string | null };
	user?: DiscordUser;
	message?: { id: string; content?: string };
	data?: { custom_id?: string; components?: unknown };
}

interface KnownChannel {
	type?: number;
	guildId?: string;
	parentId?: string;
	name?: string;
}

/**
 * One bot on Discord: the Gateway for what happens, the REST API for what
 * the bot says, and the translation between Discord channels and gateway
 * conversations.
 */
export class DiscordRuntime {
	private readonly rest: DiscordRest;
	private readonly gateway: DiscordGateway;
	private botUserId?: string;
	private ready = false;
	private stopping = false;
	private healthState: HealthState = "starting";
	private healthMessage?: string;
	private readonly channels = new Map<string, KnownChannel>();
	private readonly outboxes = new Map<string, ChannelOutbox>();
	/** Pending prompts by their custom-ID key. */
	private readonly pending = new Map<string, PendingInteraction>();
	private readonly expiryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly processed = new Set<string>();
	private readonly inboundChains = new Map<string, Promise<void>>();

	public constructor(
		private readonly config: DiscordChannelConfig,
		private readonly context: ChannelContext<unknown>,
		deps: DiscordRuntimeDeps = {},
	) {
		const token = normalizeToken(config.botToken);

		this.rest = new DiscordRest({
			token,
			fetch: deps.fetch,
			onLimited: (route, waitMs) => {
				context.logger.info("Rate-limited by Discord; waiting.", {
					route,
					waitMs,
				});
			},
		});
		this.gateway = new DiscordGateway({
			token,
			createSocket: deps.createSocket,
			gatewayUrl: () =>
				this.rest
					.request<{ url?: string }>("GET", "/gateway/bot")
					.then((body) => body.url ?? DEFAULT_GATEWAY_URL)
					.catch(() => DEFAULT_GATEWAY_URL),
			onDispatch: (type, data) => this.onDispatch(type, data),
			onStatus: (state, message) => {
				if (state === "ready") {
					this.ready = true;
				}

				this.setHealth(state, message);
			},
		});
	}

	private get streaming(): boolean {
		const mode = this.config.delivery?.mode;
		return mode === "streamChunks" || mode === "debounceChunks";
	}

	public health(): ChannelHealth {
		return {
			state: this.healthState,
			...(this.healthMessage ? { message: this.healthMessage } : {}),
			checkedAt: new Date().toISOString(),
		};
	}

	/**
	 * Check the token, then connect to the Gateway. A token Discord rejects
	 * fails here; a Discord that can't be reached is retried in the
	 * background while health() says so.
	 */
	public async start(): Promise<void> {
		try {
			const me = await this.rest.request<DiscordUser>("GET", "/users/@me");
			this.botUserId = me.id;
		} catch (error) {
			if (error instanceof DiscordApiError && error.status === 401) {
				const message = describeDiscordError(error);
				this.setHealth("stopped", message);
				throw new DiscordSetupError(message);
			}

			this.setHealth("degraded", describeDiscordError(error));
		}

		this.gateway.start();
	}

	public async stop(): Promise<void> {
		this.stopping = true;

		for (const timer of this.expiryTimers.values()) {
			clearTimeout(timer);
		}

		await Promise.race([
			Promise.all(
				[...this.outboxes.values()].map((outbox) => outbox.endTurn()),
			),
			Bun.sleep(5_000),
		]);
		this.gateway.stop();
		this.setHealth("stopped");
	}

	public async send(message: ChannelOutboundMessage): Promise<ChannelAck> {
		const channelId = message.conversationId;

		if (!this.ready) {
			return {
				ok: false,
				retryAfterMs: 5_000,
				error: this.healthMessage ?? "The Discord channel is still connecting.",
			};
		}

		const outbox = this.outbox(channelId);

		try {
			if (message.interaction) {
				const key = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
				const content = renderInteraction(
					message.text ?? "",
					message.interaction,
					key,
				);
				const messageId = await outbox.send(content, nonce(message.id));
				this.trackInteraction(message, {
					channelId,
					key,
					messageId,
					content: content.content,
				});
				return { ok: true, messageId };
			}

			if (message.attachment) {
				return await this.sendAttachment(
					channelId,
					outbox,
					message.attachment,
					message.id,
				);
			}

			if (message.event?.type === "toolCall") {
				outbox.toolCall(message.event.toolCall);
				return { ok: true, messageId: message.id };
			}

			if (message.event || !message.text?.trim()) {
				// Thoughts are not shown; other events have nothing to render.
				return { ok: true, messageId: message.id };
			}

			if (message.origin === "turn" && this.streaming) {
				outbox.appendReply(message.text, nonce(message.id));
				return { ok: true, messageId: message.id };
			}

			let messageId: string | undefined;

			for (const [index, part] of splitMessage(message.text).entries()) {
				messageId = await outbox.send(
					{ content: part },
					index === 0 ? nonce(message.id) : undefined,
				);
			}

			return { ok: true, messageId };
		} catch (error) {
			return this.failedAck(error);
		}
	}

	/**
	 * Upload a file and post it. A file Discord will not take is not a
	 * delivery failure to retry: the channel is told why, and the send counts
	 * as done, because the person waiting has been answered.
	 */
	private async sendAttachment(
		channelId: string,
		outbox: ChannelOutbox,
		attachment: ChannelAttachment,
		id: string | undefined,
	): Promise<ChannelAck> {
		const refuse = async (reason: string) => {
			this.context.logger.warn("A file was not sent to Discord.", {
				channelId,
				name: attachment.name,
				size: attachment.size,
				reason,
			});
			const messageId = await outbox.send(
				{ content: attachmentNotice(attachment, reason), quiet: true },
				nonce(id),
			);
			return { ok: true, messageId };
		};

		// Checked before the file is read: a 2 GB video is refused without
		// being loaded into memory first.
		const tooLarge = uploadLimitProblem(
			attachment.size,
			this.config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
		);

		if (tooLarge) {
			return refuse(tooLarge);
		}

		const bytes =
			attachment.data ?? (await Bun.file(attachment.path ?? "").bytes());

		try {
			const sent = await outbox.after(() =>
				this.rest.request<{ id: string }>(
					"POST",
					`/channels/${channelId}/messages`,
					{ form: () => uploadForm(attachment, bytes, nonce(id)) },
				),
			);
			return { ok: true, messageId: sent.id };
		} catch (error) {
			if (isTooLarge(error)) {
				return refuse("Discord refused it as too large.");
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

		const reason = describeDiscordError(error);

		// Client errors (missing access, unknown channel) will not get better by retrying.
		if (
			error instanceof DiscordApiError &&
			error.status >= 400 &&
			error.status < 500
		) {
			return { ok: false, error: reason };
		}

		return { ok: false, retryAfterMs: 2_000, error: reason };
	}

	private setHealth(state: HealthState, message?: string): void {
		if (state !== this.healthState || message !== this.healthMessage) {
			const log = state === "ready" ? "info" : "warn";
			this.context.logger[log](
				`Discord channel ${state}.`,
				message ? { reason: message } : undefined,
			);
		}

		this.healthState = state;
		this.healthMessage = message;
	}

	private onDispatch(type: string, data: unknown): void {
		switch (type) {
			case "READY": {
				const ready = data as { user: DiscordUser };
				this.botUserId = ready.user.id;
				this.context.logger.info("Connected to Discord.", {
					bot: ready.user.username,
				});
				return;
			}
			case "GUILD_CREATE": {
				const guild = data as {
					id: string;
					channels?: DiscordChannel[];
					threads?: DiscordChannel[];
				};

				for (const channel of [
					...(guild.channels ?? []),
					...(guild.threads ?? []),
				]) {
					this.know({ ...channel, guild_id: guild.id });
				}
				return;
			}
			case "CHANNEL_CREATE":
			case "CHANNEL_UPDATE":
			case "THREAD_CREATE":
			case "THREAD_UPDATE":
				this.know(data as DiscordChannel);
				return;
			case "THREAD_LIST_SYNC":
				for (const thread of (data as { threads?: DiscordChannel[] }).threads ??
					[]) {
					this.know(thread);
				}
				return;
			case "CHANNEL_DELETE":
			case "THREAD_DELETE":
				this.channels.delete((data as DiscordChannel).id);
				return;
			case "MESSAGE_CREATE": {
				const message = data as DiscordMessage;
				this.chainInbound(message.channel_id, () => this.onMessage(message));
				return;
			}
			case "INTERACTION_CREATE":
				// Not queued behind the channel's messages: Discord wants an
				// answer within three seconds.
				void this.onInteraction(data as DiscordInteraction).catch((error) => {
					this.context.logger.warn("Could not answer a Discord interaction.", {
						error: describeDiscordError(error),
					});
				});
				return;
			default:
				return;
		}
	}

	private know(channel: DiscordChannel): void {
		this.channels.set(channel.id, {
			type: channel.type,
			guildId: channel.guild_id,
			parentId: channel.parent_id ?? undefined,
			name: channel.name,
		});
	}

	/** What a channel is and where; asked of Discord once if the Gateway has not said. */
	private async place(
		channelId: string,
		guildId: string | undefined,
	): Promise<MessagePlace & KnownChannel> {
		let known = this.channels.get(channelId);

		if (!known) {
			try {
				const channel = await this.rest.request<DiscordChannel>(
					"GET",
					`/channels/${channelId}`,
				);
				this.know({ ...channel, guild_id: channel.guild_id ?? guildId });
				known = this.channels.get(channelId);
			} catch {
				// Without it a thread is treated as a channel of its own.
			}
		}

		return {
			...known,
			channelId,
			guildId: guildId ?? known?.guildId,
			parentId: isThread(known?.type) ? known?.parentId : undefined,
		};
	}

	/** Inbound work for a channel runs in arrival order. */
	private chainInbound(channelId: string, task: () => Promise<void>): void {
		const previous = this.inboundChains.get(channelId) ?? Promise.resolve();
		const next = previous.then(task).catch((error) => {
			this.context.logger.error("Could not handle a Discord message.", {
				channelId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.inboundChains.set(channelId, next);
	}

	private async onMessage(message: DiscordMessage): Promise<void> {
		if (
			this.processed.has(message.id) ||
			message.author.bot ||
			message.webhook_id ||
			message.author.id === this.botUserId ||
			!isUserMessageType(message.type)
		) {
			return;
		}

		this.remember(message.id);
		const place = await this.place(message.channel_id, message.guild_id);

		if (
			!isSenderAllowed(
				this.config.permissions?.inbound,
				message.author.id,
				place,
			)
		) {
			return;
		}

		const content = message.content ?? "";
		const botId = this.botUserId ?? "";
		const repliedTo = message.message_reference?.message_id;
		const promptReply = repliedTo
			? this.findPendingByMessage(message.channel_id, repliedTo)
			: undefined;

		if (
			this.config.requireMention &&
			place.guildId &&
			!promptReply &&
			!mentionsBot(content, message.mentions, botId)
		) {
			return;
		}

		const text = stripBotMention(content, botId);

		if (!text) {
			if ((message.attachments ?? []).length > 0) {
				await this.notice(
					message.channel_id,
					"I can only read text messages for now.",
				);
			}

			return;
		}

		const pending = promptReply ?? this.latestPending(message.channel_id);
		const answer = pending ? answerFromText(pending, text) : undefined;

		if (pending && answer) {
			this.answer(pending, answer, this.inboundEvent(message, place, ""));
			this.editPrompt(
				pending,
				answeredContent(
					pending.content ?? "",
					describeAnswer(pending, answer),
					`<@${message.author.id}>`,
				),
			);
			return;
		}

		// A new message ends the turn's live reply, so the next one starts
		// below the user's message.
		await this.outbox(message.channel_id).endTurn();
		void this.rest
			.request("POST", `/channels/${message.channel_id}/typing`)
			.catch(() => undefined);
		this.emit(this.inboundEvent(message, place, text));
	}

	private inboundEvent(
		message: DiscordMessage,
		place: MessagePlace & KnownChannel,
		text: string,
	): ChannelInboundEvent {
		const author = message.author;
		const event = createTextInboundEvent({
			id: message.id,
			text,
			conversationId: message.channel_id,
			conversationType: conversationType(place.type, place.guildId),
			senderId: author.id,
			senderName: message.member?.nick ?? author.global_name ?? author.username,
			timestamp: message.timestamp,
			raw: {
				messageId: message.id,
				channelId: message.channel_id,
				guildId: place.guildId,
			},
		});

		return this.withPlace(event, place);
	}

	private withPlace(
		event: ChannelInboundEvent,
		place: MessagePlace & KnownChannel,
	): ChannelInboundEvent {
		const parents = parentIds(place);

		if (parents.length > 0) {
			event.conversation.parentIds = parents;
		}

		if (place.name) {
			event.conversation.title = `#${place.name}`;
		}

		return event;
	}

	private async onInteraction(interaction: DiscordInteraction): Promise<void> {
		if (
			interaction.type !== InteractionType.MessageComponent &&
			interaction.type !== InteractionType.ModalSubmit
		) {
			return;
		}

		const parsed = parseCustomId(interaction.data?.custom_id ?? "");

		if (!parsed) {
			return;
		}

		const user = interaction.member?.user ?? interaction.user;
		const channelId = interaction.channel_id ?? interaction.channel?.id ?? "";
		const known = this.channels.get(channelId);
		const channelType = interaction.channel?.type ?? known?.type;
		const place: MessagePlace & KnownChannel = {
			channelId,
			type: channelType,
			name: interaction.channel?.name ?? known?.name,
			guildId: interaction.guild_id ?? known?.guildId,
			parentId: isThread(channelType)
				? (interaction.channel?.parent_id ?? known?.parentId ?? undefined)
				: undefined,
		};

		if (
			!user ||
			!isSenderAllowed(this.config.permissions?.inbound, user.id, place)
		) {
			await this.respond(interaction, Callback.Message, {
				content: "You are not on this bot's allowlist.",
				flags: EPHEMERAL,
			});
			return;
		}

		const pending = this.livePending(parsed.key);

		if (!pending) {
			await this.respond(
				interaction,
				Callback.UpdateMessage,
				messageBody(expiredContent(interaction.message?.content ?? "")),
			);
			return;
		}

		let answer: ChannelInteractionResponse | "form" | undefined;

		if (interaction.type === InteractionType.ModalSubmit) {
			const result = answerFromModal(
				pending,
				modalValues(interaction.data?.components),
			);

			if ("problem" in result) {
				await this.respond(interaction, Callback.Message, {
					content: `${result.problem} Tap Answer… to try again.`,
					flags: EPHEMERAL,
				});
				return;
			}

			answer = result.response;
		} else {
			answer = answerFromComponent(pending, parsed.action);
		}

		if (answer === "form") {
			await this.respond(interaction, Callback.Modal, formModal(pending));
			return;
		}

		if (!answer) {
			await this.respond(interaction, Callback.DeferredUpdate);
			return;
		}

		await this.respond(
			interaction,
			Callback.UpdateMessage,
			messageBody(
				answeredContent(
					pending.content ?? interaction.message?.content ?? "",
					describeAnswer(pending, answer),
					`<@${user.id}>`,
				),
			),
		);

		const event = createTextInboundEvent({
			id: interaction.id,
			text: "",
			conversationId: channelId,
			conversationType: conversationType(place.type, place.guildId),
			senderId: user.id,
			senderName: interaction.member?.nick ?? user.global_name ?? user.username,
			raw: { interactionId: interaction.id, channelId },
		});
		this.answer(pending, answer, this.withPlace(event, place));
	}

	/** Answer an interaction. Its own token authorizes it, within three seconds. */
	private respond(
		interaction: DiscordInteraction,
		type: number,
		data?: Record<string, unknown>,
	): Promise<unknown> {
		return this.rest.request(
			"POST",
			`/interactions/${interaction.id}/${interaction.token}/callback`,
			{
				json: data ? { type, data } : { type },
				unauthenticated: true,
			},
		);
	}

	/** Hand the answer to the gateway, as the inbound event `event`. */
	private answer(
		pending: PendingInteraction,
		response: ChannelInteractionResponse,
		event: ChannelInboundEvent,
	): void {
		this.forgetPending(pending);
		event.interaction = response;
		this.emit(event);
	}

	/** Hand an event to the gateway without holding up the channel's inbound order. */
	private emit(event: ChannelInboundEvent): void {
		void Promise.resolve(this.context.emit(event)).catch((error) => {
			this.context.logger.error("The gateway did not take a Discord message.", {
				eventId: event.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private remember(messageId: string): void {
		this.processed.add(messageId);

		if (this.processed.size > PROCESSED_MEMORY) {
			const oldest = this.processed.values().next().value;

			if (oldest) {
				this.processed.delete(oldest);
			}
		}
	}

	private trackInteraction(
		message: ChannelOutboundMessage,
		shown: {
			channelId: string;
			key: string;
			messageId: string;
			content: string;
		},
	): void {
		const { channelId, key } = shown;
		const prompt = message.interaction;

		if (!prompt) {
			return;
		}

		const timeoutMs =
			(this.config.permissions?.interactionTimeoutSeconds ?? 120) * 1000;
		const pending = createPendingInteraction({
			prompt,
			key,
			channelId,
			expiresAt: Date.now() + timeoutMs,
		});
		pending.messageId = shown.messageId;
		pending.content = shown.content;
		this.pending.set(key, pending);

		// When the gateway stops waiting, the buttons go: a press would do nothing.
		const timer = setTimeout(() => {
			if (this.pending.get(key) === pending) {
				this.forgetPending(pending);
				this.editPrompt(pending, expiredContent(pending.content ?? ""));
			}
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		this.expiryTimers.set(key, timer);
	}

	private forgetPending(pending: PendingInteraction): void {
		this.pending.delete(pending.key);
		clearTimeout(this.expiryTimers.get(pending.key));
		this.expiryTimers.delete(pending.key);
	}

	private editPrompt(
		pending: PendingInteraction,
		content: MessageContent,
	): void {
		const messageId = pending.messageId;

		if (!messageId || this.stopping) {
			return;
		}

		void this.outbox(pending.channelId)
			.run(() => this.transport(pending.channelId).edit(messageId, content))
			.catch(() => undefined);
	}

	private livePending(key: string): PendingInteraction | undefined {
		const pending = this.pending.get(key);

		if (pending && pending.expiresAt < Date.now()) {
			this.forgetPending(pending);
			return undefined;
		}

		return pending;
	}

	private channelPending(channelId: string): PendingInteraction[] {
		return [...this.pending.keys()]
			.map((key) => this.livePending(key))
			.filter(
				(pending): pending is PendingInteraction =>
					pending?.channelId === channelId,
			);
	}

	private findPendingByMessage(
		channelId: string,
		messageId: string,
	): PendingInteraction | undefined {
		return this.channelPending(channelId).find(
			(pending) => pending.messageId === messageId,
		);
	}

	private latestPending(channelId: string): PendingInteraction | undefined {
		return this.channelPending(channelId).at(-1);
	}

	private async notice(channelId: string, text: string): Promise<void> {
		try {
			await this.outbox(channelId).send({ content: text, quiet: true });
		} catch (error) {
			this.context.logger.warn("Could not send a notice.", {
				channelId,
				error: describeDiscordError(error),
			});
		}
	}

	private transport(channelId: string): LiveMessageTransport {
		return {
			send: async (content, messageNonce) => {
				const sent = await this.rest.request<{ id: string }>(
					"POST",
					`/channels/${channelId}/messages`,
					{
						json: {
							...messageBody(content),
							...(content.quiet
								? { flags: SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS }
								: {}),
							...(messageNonce
								? { nonce: messageNonce, enforce_nonce: true }
								: {}),
						},
					},
				);
				return sent.id;
			},
			edit: async (messageId, content) => {
				await this.rest.request(
					"PATCH",
					`/channels/${channelId}/messages/${messageId}`,
					{ json: messageBody(content) },
				);
			},
		};
	}

	private outbox(channelId: string): ChannelOutbox {
		let outbox = this.outboxes.get(channelId);

		if (!outbox) {
			outbox = new ChannelOutbox({
				transport: this.transport(channelId),
				firstSendDelayMs: FIRST_SEND_DELAY_MS,
				editIntervalMs: this.config.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS,
				onError: (error) => {
					this.context.logger.warn("Could not update a Discord message.", {
						channelId,
						error: describeDiscordError(error),
					});
				},
			});
			this.outboxes.set(channelId, outbox);
		}

		return outbox;
	}
}

/** A message's JSON fields: its text, its buttons if any, and no pings. */
function messageBody(content: MessageContent): Record<string, unknown> {
	return {
		content: content.content,
		...(content.components ? { components: content.components } : {}),
		allowed_mentions: NO_MENTIONS,
	};
}

/**
 * A nonce from the gateway's message id, so a send it retries is not posted
 * twice. Discord takes 25 characters at most.
 */
function nonce(id: string | undefined): string | undefined {
	return id ? id.replaceAll("-", "").slice(0, 25) : undefined;
}
