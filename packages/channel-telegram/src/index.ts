import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	createChannelAdapter,
	defineChannel,
} from "@acpantenna/channel";
import {
	configProblems,
	TELEGRAM_CONFIG_SCHEMA,
	type TelegramChannelConfig,
} from "./config.ts";
import type { TelegramRuntime, TelegramRuntimeDeps } from "./runtime.ts";

export type { TelegramChannelConfig } from "./config.ts";

/**
 * Buttons: prompts come with their options, as an inline keyboard. Tool
 * calls: shown as a compact log. No thoughts. Files: uploaded, within the
 * Bot API's 50 MB.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
	inbound: true,
	outbound: true,
	approvals: true,
	attachments: true,
	buttons: true,
	toolCalls: true,
	thoughts: false,
};

export function createTelegramChannel(
	rawConfig: unknown,
	deps: TelegramRuntimeDeps = {},
): ChannelAdapter<unknown> {
	const config = rawConfig as TelegramChannelConfig;
	let runtime: TelegramRuntime | undefined;

	return createChannelAdapter({
		manifest: {
			type: "telegram",
			name: "Telegram",
			version: "0.0.0",
			capabilities: TELEGRAM_CAPABILITIES,
		},

		async start(context: ChannelContext<unknown>) {
			const problems = configProblems(config);

			if (problems.length > 0) {
				throw new Error(`Telegram channel: ${problems.join(" ")}`);
			}

			// Loaded only when a Telegram channel runs.
			const { TelegramRuntime } = await import("./runtime.ts");
			runtime = new TelegramRuntime(config, context, deps);
			await runtime.start();
		},

		async stop() {
			await runtime?.stop();
		},

		send(message) {
			if (!runtime) {
				return {
					ok: false,
					retryAfterMs: 5_000,
					error: "The Telegram channel is not started.",
				};
			}

			return runtime.send(message);
		},

		health() {
			return (
				runtime?.health() ?? {
					state: "starting",
					checkedAt: new Date().toISOString(),
				}
			);
		},
	});
}

export const telegramChannel = defineChannel({
	type: "telegram",
	name: "Telegram",
	description:
		"Chat with the agent through a Telegram bot, in a private chat, a group or a forum topic. Create the bot with @BotFather and give the channel its token.",
	capabilities: TELEGRAM_CAPABILITIES,
	configSchema: TELEGRAM_CONFIG_SCHEMA,
	create: (config) => createTelegramChannel(config),
});
