import type { ChannelConversation } from "@acpantenna/channel";
import type {
	TelegramMessage,
	TelegramMessageEntity,
	TelegramUser,
} from "./types.ts";

/** The inbound policy fields the channel reads (the gateway enforces them too). */
export interface InboundPolicy {
	mode?: "closed" | "allowlist" | "open";
	allow?: string[];
}

/**
 * Whether `senderId` (a numeric user id) may talk to the bot in
 * `conversationId`, by the same rule the gateway applies to messages: the
 * channel also needs it for what never reaches the gateway as a message
 * (a button pressed under a prompt).
 */
export function isSenderAllowed(
	policy: InboundPolicy | undefined,
	senderId: string,
	conversationId?: string,
): boolean {
	const mode = policy?.mode ?? "allowlist";

	if (mode === "open") {
		return true;
	}

	if (mode === "closed") {
		return false;
	}

	const allow = policy?.allow ?? [];

	return (
		allow.includes("*") ||
		allow.includes(senderId) ||
		(conversationId !== undefined && allow.includes(conversationId))
	);
}

/** A chat, or one topic of a forum group. */
export interface ConversationAddress {
	chatId: number;
	threadId?: number;
}

/**
 * The conversation a message belongs to: its chat id, or `<chat id>:<topic
 * id>` for a topic of a forum group, so each topic is a conversation of its
 * own. Replies in an ordinary group carry a thread id too; those stay in the
 * chat's conversation.
 */
export function conversationOf(message: TelegramMessage): {
	id: string;
	type: ChannelConversation["type"];
} {
	const chatId = message.chat.id;

	if (
		message.chat.is_forum &&
		message.is_topic_message &&
		message.message_thread_id !== undefined
	) {
		return {
			id: formatConversationId({
				chatId,
				threadId: message.message_thread_id,
			}),
			type: "thread",
		};
	}

	return {
		id: String(chatId),
		type: message.chat.type === "private" ? "dm" : "group",
	};
}

export function formatConversationId(address: ConversationAddress): string {
	return address.threadId === undefined
		? String(address.chatId)
		: `${address.chatId}:${address.threadId}`;
}

/** `-100123` or `-100123:45` back into a chat and topic; undefined if neither. */
export function parseConversationId(
	id: string,
): ConversationAddress | undefined {
	const match = /^(-?\d+)(?::(\d+))?$/.exec(id.trim());

	if (!match) {
		return undefined;
	}

	return {
		chatId: Number(match[1]),
		...(match[2] ? { threadId: Number(match[2]) } : {}),
	};
}

export function displayName(user: TelegramUser): string {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
	return name || (user.username ? `@${user.username}` : String(user.id));
}

/** The bot itself, as getMe describes it. */
export interface BotIdentity {
	id: number;
	username: string;
}

/**
 * Whether a message is for the bot, and its text without the bot's name.
 * In a private chat everything is. In a group, with `requireMention`, only a
 * message that @mentions the bot, replies to one of its messages, or is a
 * command (`/new`, or `/new@thebot`, not `/new@anotherbot`); without it,
 * every message. `/cancel@thebot` comes out as `/cancel`, the gateway's
 * command.
 */
export function addressedText(
	message: TelegramMessage,
	bot: BotIdentity,
	requireMention: boolean,
): { addressed: boolean; text: string } {
	const raw = message.text ?? message.caption ?? "";
	const entities = message.entities ?? message.caption_entities ?? [];
	const username = bot.username.toLowerCase();
	let addressed = message.chat.type === "private" || !requireMention;
	let command = false;
	const cuts: Array<{ start: number; end: number; replace: string }> = [];

	for (const entity of entities) {
		const part = raw.slice(entity.offset, entity.offset + entity.length);

		if (isMention(entity, part, bot, username)) {
			addressed = true;
			cuts.push({
				start: entity.offset,
				end: entity.offset + entity.length,
				replace: "",
			});
		} else if (entity.type === "bot_command" && entity.offset === 0) {
			const [name, target] = part.split("@");

			if (target === undefined || target.toLowerCase() === username) {
				command = true;
				cuts.push({
					start: 0,
					end: entity.length,
					replace: name ?? part,
				});
			} else if (message.chat.type !== "private") {
				// A command for another bot in the group.
				return { addressed: false, text: raw };
			}
		}
	}

	const reply = message.reply_to_message;

	if (
		reply?.from?.id === bot.id &&
		// In a forum, every message in a topic "replies" to the topic's first
		// message; only a reply to something else is a reply to the bot.
		reply.message_id !== message.message_thread_id
	) {
		addressed = true;
	}

	let text = raw;

	for (const cut of cuts.sort((left, right) => right.start - left.start)) {
		text = text.slice(0, cut.start) + cut.replace + text.slice(cut.end);
	}

	text = text.replace(/^[\s,:;]+/, "").replace(/\s+$/, "");

	return { addressed: addressed || command, text };
}

function isMention(
	entity: TelegramMessageEntity,
	part: string,
	bot: BotIdentity,
	username: string,
): boolean {
	if (entity.type === "mention") {
		return part.toLowerCase() === `@${username}`;
	}

	return entity.type === "text_mention" && entity.user?.id === bot.id;
}
