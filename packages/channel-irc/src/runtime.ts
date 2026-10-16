import {
	attachmentNotice,
	type ChannelAck,
	type ChannelContext,
	type ChannelHealth,
	type ChannelInboundEvent,
	type ChannelInteractionResponse,
	type ChannelOutboundMessage,
	createTextInboundEvent,
} from "@acpantenna/channel";
import { IrcClient, type IrcClientState, type IrcIncoming } from "./client.ts";
import {
	DEFAULT_MAX_LINES,
	DEFAULT_REALNAME,
	DEFAULT_SEND_BURST,
	DEFAULT_SEND_INTERVAL_MS,
	type IrcChannelConfig,
	parseChannelEntry,
	resolvePort,
} from "./config.ts";
import type { Schedule } from "./flood.ts";
import {
	addressedText,
	type IrcSender,
	isSenderAllowed,
	spoofableEntries,
} from "./inbound.ts";
import {
	answerFromText,
	createPendingInteraction,
	describeAnswer,
	isOptionAnswer,
	type PendingInteraction,
	renderInteraction,
} from "./interactions.ts";
import { ConversationOutbox } from "./outbox.ts";
import { type Connect, connectSocket } from "./socket.ts";

export interface IrcRuntimeDeps {
	connect?: Connect;
	schedule?: Schedule;
	now?: () => number;
	random?: () => number;
}

const MORE_WORDS = ["more", "continue"];

/** A message, who sent it, and the conversation it belongs to. */
interface From {
	message: IrcIncoming;
	sender: IrcSender;
	conversationId: string;
}

/**
 * One nick on one IRC network: the connection, and the translation between
 * IRC channels and private messages and gateway conversations.
 */
export class IrcRuntime {
	private readonly client: IrcClient;
	private readonly outboxes = new Map<string, ConversationOutbox>();
	private readonly pending = new Map<string, Map<string, PendingInteraction>>();
	private healthState: ChannelHealth["state"] = "starting";
	private healthMessage?: string;
	private readonly now: () => number;

	public constructor(
		private readonly config: IrcChannelConfig,
		private readonly context: ChannelContext<unknown>,
		private readonly deps: IrcRuntimeDeps = {},
	) {
		this.now = deps.now ?? Date.now;
		this.client = new IrcClient(
			{
				host: config.server,
				port: resolvePort(config),
				tls: config.tls ?? true,
				tlsVerify: config.tlsVerify ?? true,
				nick: config.nick,
				username: config.username ?? config.nick,
				realname: config.realname ?? DEFAULT_REALNAME,
				account: config.account ?? config.nick,
				password: config.password || undefined,
				nickserv: config.nickserv ?? false,
				serverPassword: config.serverPassword || undefined,
				channels: (config.channels ?? []).map(parseChannelEntry),
				sendBurst: config.sendBurst ?? DEFAULT_SEND_BURST,
				sendIntervalMs: config.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS,
				connect: deps.connect ?? connectSocket,
				logger: context.logger,
				schedule: deps.schedule,
				now: deps.now,
				random: deps.random,
			},
			{
				message: (message) => this.onMessage(message),
				state: (state, message) => this.setHealth(state, message),
			},
		);
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

	public async start(): Promise<void> {
		const spoofable = spoofableEntries(this.config.permissions?.inbound);

		if (spoofable.length > 0) {
			this.context.logger.warn(
				"The IRC allowlist trusts bare nicks, which anyone can take; prefer account:<name> or a nick!user@host mask.",
				{ entries: spoofable },
			);
		}

		await this.client.start();
	}

	public async stop(): Promise<void> {
		for (const outbox of this.outboxes.values()) {
			outbox.endTurn();
		}

		// What is still waiting for the flood limit gets a moment to go out.
		for (
			let waited = 0;
			this.client.backlog > 0 && waited < 5_000;
			waited += 100
		) {
			await Bun.sleep(100);
		}

		this.client.stop();
	}

	public send(message: ChannelOutboundMessage): ChannelAck {
		if (!this.client.ready) {
			return {
				ok: false,
				retryAfterMs: 5_000,
				error: this.healthMessage ?? "The IRC channel is still connecting.",
			};
		}

		const target = message.conversationId;

		if (!target || /[\s,\0\r\n]/.test(target)) {
			return { ok: false, error: `"${target}" is not an IRC channel or nick.` };
		}

		const outbox = this.outbox(target);
		const messageId = message.id ?? crypto.randomUUID();

		try {
			if (message.interaction) {
				const channel = this.client.isChannel(target);
				outbox.lines(
					renderInteraction(
						message.text ?? "",
						message.interaction,
						channel ? `${this.client.nick}: ` : "",
					),
				);
				this.trackInteraction(target, message);
				return { ok: true, messageId };
			}

			if (message.attachment) {
				// Not declared, so not expected; said rather than dropped if it comes.
				outbox.notice(
					attachmentNotice(message.attachment, "IRC carries text only."),
				);
				return { ok: true, messageId };
			}

			if (message.event?.type === "toolCall") {
				if (this.config.showToolCalls ?? true) {
					outbox.toolCall(message.event.toolCall);
				}

				return { ok: true, messageId };
			}

			if (message.event || !message.text) {
				// Thoughts are not shown; other events have nothing to render.
				return { ok: true, messageId };
			}

			if (message.origin === "turn" && this.streaming) {
				outbox.appendReply(message.text);
			} else {
				outbox.reply(message.text);
			}

			return { ok: true, messageId };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** One message from someone, to the bot or a channel it is in. */
	private onMessage(message: IrcIncoming): void {
		// Notices are what bots send; answering them invites loops.
		if (message.command !== "PRIVMSG") {
			return;
		}

		const inChannel = this.client.isChannel(message.target);
		const conversationId = this.client.fold(
			inChannel ? message.target : message.source.nick,
		);
		const sender: IrcSender = {
			nick: message.source.nick,
			...(message.source.user ? { user: message.source.user } : {}),
			...(message.source.host ? { host: message.source.host } : {}),
			...(message.account ? { account: message.account } : {}),
		};

		if (
			!isSenderAllowed(
				this.config.permissions?.inbound,
				sender,
				conversationId,
				this.client,
			)
		) {
			this.context.logger.debug(
				"Ignored an IRC message from a sender not on the allowlist.",
				{
					sender: `${sender.nick}!${sender.user}@${sender.host}`,
					account: sender.account,
					conversationId,
				},
			);
			return;
		}

		const addressed = inChannel
			? addressedText(message.text, this.client.nicks, this.client.caseMapping)
			: message.text.trim();
		const pending = this.latestPending(conversationId);

		if (pending) {
			// A number or yes/no needs no address, even in a channel; a form's
			// free text does, or every remark would be taken for the answer.
			const answer =
				addressed !== undefined
					? answerFromText(pending, addressed)
					: isOptionAnswer(pending, message.text)
						? answerFromText(pending, message.text)
						: undefined;

			if (answer) {
				this.answer({ message, sender, conversationId }, pending, answer);
				return;
			}
		}

		const outbox = this.outbox(conversationId);

		if (
			addressed !== undefined &&
			MORE_WORDS.includes(addressed.toLowerCase().replace(/[.!]+$/, "")) &&
			outbox.more()
		) {
			return;
		}

		const respondAlways = (this.config.respond ?? "mention") === "always";
		const text = addressed ?? (respondAlways ? message.text.trim() : undefined);

		if (!text) {
			return;
		}

		// A new message ends the turn's reply, so the next one starts fresh.
		outbox.endTurn();
		this.emit(this.toInboundEvent({ message, sender, conversationId }, text));
	}

	private toInboundEvent(from: From, text: string): ChannelInboundEvent {
		const { message, sender, conversationId } = from;
		const inChannel = this.client.isChannel(message.target);
		const mask = `${sender.nick}!${sender.user ?? "*"}@${sender.host ?? "*"}`;

		return createTextInboundEvent({
			...(message.tags.msgid ? { id: message.tags.msgid } : {}),
			text: message.action ? `* ${sender.nick} ${text}` : text,
			conversationId,
			conversationType: inChannel ? "room" : "dm",
			senderId: sender.account ? `account:${sender.account}` : mask,
			senderName: sender.nick,
			// Allowed here, by mask or account, which the gateway cannot match.
			trusted: true,
			...(message.tags.time ? { timestamp: message.tags.time } : {}),
			raw: {
				target: message.target,
				source: mask,
				...(sender.account ? { account: sender.account } : {}),
			},
		});
	}

	/** Hand an event to the gateway without holding up the next line. */
	private emit(event: ChannelInboundEvent): void {
		void Promise.resolve(this.context.emit(event)).catch((error) => {
			this.context.logger.error("The gateway did not take an IRC message.", {
				eventId: event.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private answer(
		from: From,
		pending: PendingInteraction,
		response: ChannelInteractionResponse,
	): void {
		const { sender, conversationId } = from;
		this.pending.get(conversationId)?.delete(pending.id);
		const inbound = this.toInboundEvent(from, "");
		inbound.interaction = response;
		this.emit(inbound);
		this.outbox(conversationId).notice(
			`→ ${describeAnswer(pending, response)} (${sender.nick})`,
		);
	}

	private trackInteraction(
		target: string,
		message: ChannelOutboundMessage,
	): void {
		const prompt = message.interaction;

		if (!prompt) {
			return;
		}

		const timeoutSeconds =
			this.config.permissions?.interactionTimeoutSeconds ?? 120;
		const key = this.client.fold(target);
		const pending = createPendingInteraction(
			prompt,
			this.now() + timeoutSeconds * 1000,
		);
		const room = this.pending.get(key) ?? new Map<string, PendingInteraction>();

		room.set(prompt.id, pending);
		this.pending.set(key, room);
	}

	private latestPending(
		conversationId: string,
	): PendingInteraction | undefined {
		const room = this.pending.get(conversationId);

		if (!room) {
			return undefined;
		}

		const now = this.now();

		for (const [id, pending] of room) {
			if (pending.expiresAt < now) {
				room.delete(id);
			}
		}

		return [...room.values()].at(-1);
	}

	private outbox(target: string): ConversationOutbox {
		const key = this.client.fold(target);
		let outbox = this.outboxes.get(key);

		if (!outbox) {
			const channel = this.client.isChannel(target);
			outbox = new ConversationOutbox({
				target,
				transport: {
					privmsg: (to, text) => this.client.privmsg(to, text),
					notice: (to, text) => this.client.notice(to, text),
					budget: (command, to) => this.client.budget(command, to),
				},
				maxLines: this.config.maxLines ?? DEFAULT_MAX_LINES,
				moreCommand: () => (channel ? `${this.client.nick}: more` : "more"),
				schedule: this.deps.schedule,
			});
			this.outboxes.set(key, outbox);
		}

		return outbox;
	}

	private setHealth(state: IrcClientState, message?: string): void {
		this.healthState = state;
		this.healthMessage = message;
	}
}
