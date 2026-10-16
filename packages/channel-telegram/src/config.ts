import type { ChannelConfigSchema } from "@acpantenna/channel";
import type { InboundPolicy } from "./inbound.ts";

export const DEFAULT_API_URL = "https://api.telegram.org";
export const DEFAULT_EDIT_INTERVAL_MS = 1_000;

export interface TelegramChannelConfig {
	type: "telegram";
	/** The token BotFather gave the bot, like 123456:ABC-DEF…. */
	botToken: string;
	/** The Bot API server. Default https://api.telegram.org. */
	apiUrl?: string;
	/** In groups, answer only messages that mention the bot or reply to it. Default true. */
	requireMention?: boolean;
	/**
	 * Least time between two edits of a streamed message in a private chat.
	 * Default 1000ms; groups use at least 3000ms.
	 */
	editIntervalMs?: number;
	/** Generic channel fields the gateway resolves; read, not owned, here. */
	permissions?: {
		inbound?: InboundPolicy;
		interactionTimeoutSeconds?: number;
	};
	delivery?: { mode?: string };
}

export const TELEGRAM_CONFIG_SCHEMA: ChannelConfigSchema = {
	type: "object",
	properties: {
		botToken: {
			type: "string",
			title: "Bot token",
			description:
				"The token @BotFather gave the bot when you created it with /newbot, like 123456789:AAE….",
			secret: true,
		},
		apiUrl: {
			type: "string",
			title: "Bot API server",
			description:
				"Where the Bot API is. Change it only for a Bot API server of your own.",
			default: DEFAULT_API_URL,
		},
		requireMention: {
			type: "boolean",
			title: "Only when mentioned in groups",
			description:
				"In a group, answer only messages that @mention the bot or reply to one of its messages. Private chats are always answered.",
			default: true,
		},
		editIntervalMs: {
			type: "number",
			title: "Edit interval (ms)",
			description:
				"Least time between edits of a reply as it streams in. Telegram allows about one per second in a chat; groups use at least 3000.",
			default: DEFAULT_EDIT_INTERVAL_MS,
		},
	},
	required: ["botToken"],
};

/** The fields the channel cannot start without, as a readable list of problems. */
export function configProblems(
	config: Partial<TelegramChannelConfig>,
): string[] {
	const problems: string[] = [];
	const apiUrl = config.apiUrl ?? DEFAULT_API_URL;

	try {
		const url = new URL(apiUrl);

		if (url.protocol !== "https:" && url.protocol !== "http:") {
			problems.push("apiUrl must be an http(s) URL.");
		}
	} catch {
		problems.push(`apiUrl is not a URL: ${apiUrl}`);
	}

	if (!config.botToken) {
		problems.push("Set the bot's token (from @BotFather).");
	} else if (!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken)) {
		problems.push(
			"botToken does not look like a bot token; BotFather's look like 123456789:AAE….",
		);
	}

	if (
		config.editIntervalMs !== undefined &&
		!(Number.isFinite(config.editIntervalMs) && config.editIntervalMs >= 0)
	) {
		problems.push("editIntervalMs must be a number of milliseconds.");
	}

	return problems;
}
