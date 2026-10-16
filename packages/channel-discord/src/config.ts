import type { ChannelConfigSchema } from "@acpantenna/channel";
import type { InboundPolicy } from "./inbound.ts";

/** Discord's own limit for a bot's upload where a server has no boost: 10 MiB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EDIT_INTERVAL_MS = 1500;

export interface DiscordChannelConfig {
	type: "discord";
	/** The bot's token, from the developer portal's Bot page. */
	botToken: string;
	/** In server channels, answer only messages that @mention the bot. Default false. */
	requireMention?: boolean;
	/** Least time between two edits of a streamed message. Default 1500ms. */
	editIntervalMs?: number;
	/** Largest file the bot uploads. Default 10 MiB, Discord's limit without boosts. */
	maxUploadBytes?: number;
	/** Generic channel fields the gateway resolves; read, not owned, here. */
	permissions?: {
		inbound?: InboundPolicy;
		interactionTimeoutSeconds?: number;
	};
	delivery?: { mode?: string };
}

export const DISCORD_CONFIG_SCHEMA: ChannelConfigSchema = {
	type: "object",
	properties: {
		botToken: {
			type: "string",
			title: "Bot token",
			description:
				"The bot's token, from your application's Bot page in the Discord developer portal (Reset Token).",
			secret: true,
		},
		requireMention: {
			type: "boolean",
			title: "Only when mentioned",
			description:
				"In server channels, answer only messages that @mention the bot. Direct messages are always answered.",
			default: false,
		},
		editIntervalMs: {
			type: "number",
			title: "Edit interval (ms)",
			description:
				"Least time between edits of a reply as it streams in. Discord allows about five message edits per five seconds in a channel.",
			default: DEFAULT_EDIT_INTERVAL_MS,
		},
		maxUploadBytes: {
			type: "number",
			title: "Largest upload (bytes)",
			description:
				"Files the agent sends above this are not uploaded; the channel is told instead. Discord takes 10 MiB without boosts, 50 MiB in a server at boost level 2, 100 MiB at level 3.",
			default: DEFAULT_MAX_UPLOAD_BYTES,
		},
	},
	required: ["botToken"],
};

/** The token as Discord's Authorization header wants it after `Bot `. */
export function normalizeToken(token: string): string {
	return token.trim().replace(/^Bot\s+/i, "");
}

/** The fields the channel cannot start without, as a readable list of problems. */
export function configProblems(
	config: Partial<DiscordChannelConfig>,
): string[] {
	const problems: string[] = [];
	const token = normalizeToken(config.botToken ?? "");

	if (!token) {
		problems.push("Set the bot's token (botToken).");
	} else if (/\s/.test(token)) {
		problems.push("botToken has spaces in it; paste the token alone.");
	}

	if (
		config.editIntervalMs !== undefined &&
		!(Number.isFinite(config.editIntervalMs) && config.editIntervalMs >= 0)
	) {
		problems.push(
			"editIntervalMs must be a number of milliseconds, 0 or more.",
		);
	}

	if (
		config.maxUploadBytes !== undefined &&
		!(Number.isFinite(config.maxUploadBytes) && config.maxUploadBytes > 0)
	) {
		problems.push("maxUploadBytes must be a number of bytes above 0.");
	}

	return problems;
}
