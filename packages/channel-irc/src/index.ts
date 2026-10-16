import {
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelContext,
	createChannelAdapter,
	defineChannel,
} from "@acpantenna/channel";
import {
	configProblems,
	IRC_CONFIG_SCHEMA,
	type IrcChannelConfig,
} from "./config.ts";
import type { IrcRuntime } from "./runtime.ts";

export type { IrcChannelConfig } from "./config.ts";

/**
 * Plain text, a line at a time. `buttons` because the channel wants a
 * prompt's options as data: it lists them, numbered, and takes the number
 * (or the label, or yes / no) as the answer, which the gateway's own
 * spelled-out fallback cannot be answered with. Tool calls: short notices.
 * No thoughts, no files (the gateway says in text what was not sent).
 */
export const IRC_CAPABILITIES: ChannelCapabilities = {
	inbound: true,
	outbound: true,
	approvals: true,
	attachments: false,
	buttons: true,
	toolCalls: true,
	thoughts: false,
};

export function createIrcChannel(rawConfig: unknown): ChannelAdapter<unknown> {
	const config = rawConfig as IrcChannelConfig;
	let runtime: IrcRuntime | undefined;

	return createChannelAdapter({
		manifest: {
			type: "irc",
			name: "IRC",
			version: "0.0.0",
			capabilities: IRC_CAPABILITIES,
		},

		async start(context: ChannelContext<unknown>) {
			const problems = configProblems(config);

			if (problems.length > 0) {
				throw new Error(`IRC channel: ${problems.join(" ")}`);
			}

			// The client is loaded only when an IRC channel runs.
			const { IrcRuntime } = await import("./runtime.ts");
			runtime = new IrcRuntime(config, context);
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
					error: "The IRC channel is not started.",
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

export const ircChannel = defineChannel({
	type: "irc",
	name: "IRC",
	description:
		"Chat with the agent on IRC, in channels or private messages. Works with Libera.Chat, OFTC or your own server, over TLS, logged in with SASL.",
	capabilities: IRC_CAPABILITIES,
	configSchema: IRC_CONFIG_SCHEMA,
	create: createIrcChannel,
});
