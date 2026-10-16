import type { ChannelConversation } from "@acpantenna/channel";

/** The inbound policy fields the channel reads (the gateway enforces them too). */
export interface InboundPolicy {
	mode?: "closed" | "allowlist" | "open";
	allow?: string[];
}

/** Where a message was written: its channel and what that channel is inside. */
export interface MessagePlace {
	channelId: string;
	/** The server; absent in a direct message. */
	guildId?: string;
	/** For a thread, the channel it was started in. */
	parentId?: string;
}

/**
 * Whether `userId` may talk to the bot in `place`, by the same rule the
 * gateway applies to messages: a user ID, a channel ID, a thread's parent
 * channel or a server ID on the list lets it in. The channel also needs it
 * for what never reaches the gateway as a message (button presses).
 */
export function isSenderAllowed(
	policy: InboundPolicy | undefined,
	userId: string,
	place: MessagePlace,
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
		[userId, place.channelId, ...parentIds(place)].some((id) =>
			allow.includes(id),
		)
	);
}

/** What the conversation sits inside, for the gateway's allowlist. */
export function parentIds(place: MessagePlace): string[] {
	return [place.guildId, place.parentId].filter(
		(id): id is string => id !== undefined,
	);
}

/** Discord's channel types, the ones a message can be in. */
export const ChannelType = {
	GuildText: 0,
	DM: 1,
	GuildVoice: 2,
	GroupDM: 3,
	GuildAnnouncement: 5,
	AnnouncementThread: 10,
	PublicThread: 11,
	PrivateThread: 12,
	GuildStageVoice: 13,
	GuildForum: 15,
} as const;

export function isThread(type: number | undefined): boolean {
	return (
		type === ChannelType.AnnouncementThread ||
		type === ChannelType.PublicThread ||
		type === ChannelType.PrivateThread
	);
}

export function conversationType(
	type: number | undefined,
	guildId: string | undefined,
): NonNullable<ChannelConversation["type"]> {
	if (type === ChannelType.DM || (type === undefined && !guildId)) {
		return "dm";
	}

	if (type === ChannelType.GroupDM) {
		return "group";
	}

	return isThread(type) ? "thread" : "room";
}

/** Whether a message's text or mention list names the bot. */
export function mentionsBot(
	content: string,
	mentions: Array<{ id: string }> | undefined,
	botId: string,
): boolean {
	return (
		(mentions ?? []).some((user) => user.id === botId) ||
		content.includes(`<@${botId}>`) ||
		content.includes(`<@!${botId}>`)
	);
}

/** The text without the bot's own mention at its start ("@bot run the tests"). */
export function stripBotMention(content: string, botId: string): string {
	return content.replace(new RegExp(`^\\s*<@!?${botId}>[\\s,:]*`), "").trim();
}

/** Message types that are something a person wrote: a message, a reply. */
export function isUserMessageType(type: number | undefined): boolean {
	return type === undefined || type === 0 || type === 19;
}

/** The parts of a Discord API failure the channel reads. */
export interface DiscordErrorLike {
	status?: number;
	code?: number;
	message?: string;
	name?: string;
}

/** A short, human-readable reason for a Discord failure, for logs and the settings page. */
export function describeDiscordError(error: unknown): string {
	const candidate = (error ?? {}) as DiscordErrorLike;

	switch (candidate.code) {
		case 50001:
			return "The bot cannot see that channel. Add it to the channel (or give its role View Channel).";
		case 50013:
			return "The bot lacks a permission it needs there (Send Messages, Attach Files, Read Message History, …).";
		case 10003:
			return "Discord knows no such channel; check the conversation ID.";
		case 50007:
			return "Discord would not let the bot message that user (they may not share a server, or block DMs).";
		case 40005:
			return "Discord refused the file as too large.";
		default:
			break;
	}

	if (candidate.status === 401) {
		return "Discord rejected the bot token. Reset it in the developer portal and update botToken.";
	}

	const message = candidate.message ?? String(error);

	if (
		/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Unable to connect|network|socket/i.test(
			message,
		)
	) {
		return "Can't reach Discord; retrying.";
	}

	if (candidate.status && candidate.status >= 500) {
		return `Discord is having trouble (HTTP ${candidate.status}); retrying.`;
	}

	return message;
}
