import type { ChannelDefinition } from "@acpantenna/channel";
import { ircChannel } from "@acpantenna/channel-irc";
import { matrixChannel } from "@acpantenna/channel-matrix";
import { relayChannel } from "@acpantenna/channel-relay";
import { webhookChannel } from "@acpantenna/channel-webhook";

/** The channel types this build of acpantenna can run. */
export const builtinChannels: ChannelDefinition[] = [
	webhookChannel,
	matrixChannel,
	ircChannel,
	relayChannel,
];
