import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	createChannelAdapter,
	defineChannel,
} from "@acpantenna/channel";
import {
	configProblems,
	DISCORD_CONFIG_SCHEMA,
	type DiscordChannelConfig,
} from "./config.ts";
import type { DiscordRuntime } from "./runtime.ts";

export type { DiscordChannelConfig } from "./config.ts";

/**
 * Buttons: prompts come with their options, shown as message buttons (and a
 * form for questions with fields). Tool calls: shown as a compact log. No
 * thoughts. Files: uploaded, within the configured size.
 */
export const DISCORD_CAPABILITIES: ChannelCapabilities = {
	inbound: true,
	outbound: true,
	approvals: true,
	attachments: true,
	buttons: true,
	toolCalls: true,
	thoughts: false,
};

export function createDiscordChannel(
	rawConfig: unknown,
): ChannelAdapter<unknown> {
	const config = rawConfig as DiscordChannelConfig;
	let runtime: DiscordRuntime | undefined;

	return createChannelAdapter({
		manifest: {
			type: "discord",
			name: "Discord",
			version: "0.0.0",
			capabilities: DISCORD_CAPABILITIES,
		},

		async start(context: ChannelContext<unknown>) {
			const problems = configProblems(config);

			if (problems.length > 0) {
				throw new Error(`Discord channel: ${problems.join(" ")}`);
			}

			// The gateway client is loaded only when a Discord channel runs.
			const { DiscordRuntime } = await import("./runtime.ts");
			runtime = new DiscordRuntime(config, context);
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
					error: "The Discord channel is not started.",
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

export const discordChannel = defineChannel({
	type: "discord",
	name: "Discord",
	description:
		"Chat with the agent in Discord: direct messages, server channels and threads, with buttons for its questions. Add the bot to your server, or message it directly.",
	capabilities: DISCORD_CAPABILITIES,
	configSchema: DISCORD_CONFIG_SCHEMA,
	create: createDiscordChannel,
});
