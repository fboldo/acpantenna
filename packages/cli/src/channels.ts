import type { ChannelDefinition } from "@acpantenna/channel";
import { discordChannel } from "@acpantenna/channel-discord";
import { matrixChannel } from "@acpantenna/channel-matrix";
import { relayChannel } from "@acpantenna/channel-relay";
import { webhookChannel } from "@acpantenna/channel-webhook";

/** The channel types this build of acpantenna can run. */
export const builtinChannels: ChannelDefinition[] = [
	webhookChannel,
	matrixChannel,
	discordChannel,
	relayChannel,
];
