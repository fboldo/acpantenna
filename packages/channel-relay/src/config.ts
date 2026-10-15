import type { ChannelConfigSchema } from "@acpantenna/channel";
import { DEFAULT_LINK_TTL_SECONDS } from "@acpantenna/relay-protocol";

/** How often streamed message chunks are sent, batched, by default. */
export const DEFAULT_COALESCE_MS = 150;

export interface RelayChannelConfig {
	type: "relay";
	/** The relay's WebSocket URL, e.g. wss://relay.example. */
	relayUrl: string;
	/** The web client's origin, e.g. https://app.example: the link opens there. */
	webOrigin: string;
	/** How long a link can be opened, in seconds. Default 600. */
	linkTtlSeconds?: number;
	/** How often streamed message chunks are sent, batched, in ms. Default 150. */
	coalesceMs?: number;
	/**
	 * Where the channel's own key is kept: the OS `keychain` (default; a file
	 * in the state directory where there is none), or always a `file`.
	 */
	keyStorage?: "keychain" | "file";
	/** An optional credential the relay may ask agents for. */
	relayToken?: string;
	/** Generic channel fields the gateway resolves; read, not owned, here. */
	permissions?: { interactionTimeoutSeconds?: number };
}

export const RELAY_CONFIG_SCHEMA: ChannelConfigSchema = {
	type: "object",
	properties: {
		relayUrl: {
			type: "string",
			title: "Relay URL",
			description:
				"The relay that joins this machine and the browser, as a WebSocket URL: wss://…",
		},
		webOrigin: {
			type: "string",
			title: "Web client",
			description:
				"Where the web client is served, scheme and host only, e.g. https://app.example. The link opens there.",
		},
		linkTtlSeconds: {
			type: "integer",
			title: "Link lifetime (seconds)",
			description: "How long a link can be opened. It works once.",
			default: DEFAULT_LINK_TTL_SECONDS,
		},
		coalesceMs: {
			type: "integer",
			title: "Streaming tick (ms)",
			description:
				"Streamed text is sent in batches this often, so packet timing says less about it.",
			default: DEFAULT_COALESCE_MS,
		},
		keyStorage: {
			type: "string",
			title: "Key storage",
			description:
				"Where this channel's key is kept: the OS keychain, or a file in its state directory.",
			enum: ["keychain", "file"],
			default: "keychain",
		},
		relayToken: {
			type: "string",
			title: "Relay token",
			description: "A credential for the relay, if it asks for one.",
			secret: true,
		},
	},
	required: ["relayUrl", "webOrigin"],
};

/** What is wrong with a relay channel's config, in sentences; empty when nothing is. */
export function configProblems(config: Partial<RelayChannelConfig>): string[] {
	const problems: string[] = [];

	if (!isUrl(config.relayUrl, ["wss:", "ws:"])) {
		problems.push("relayUrl must be a ws:// or wss:// URL.");
	} else if (
		new URL(config.relayUrl).protocol === "ws:" &&
		!isLoopback(config.relayUrl)
	) {
		problems.push("relayUrl must use wss:// unless it is on this machine.");
	}

	if (!isUrl(config.webOrigin, ["https:", "http:"])) {
		problems.push("webOrigin must be an https:// origin.");
	} else {
		const url = new URL(config.webOrigin);

		if (url.origin !== config.webOrigin.replace(/\/$/, "")) {
			problems.push(
				"webOrigin is a scheme and host only, like https://app.example.",
			);
		} else if (url.protocol === "http:" && !isLoopback(config.webOrigin)) {
			problems.push(
				"webOrigin must use https:// unless it is on this machine.",
			);
		}
	}

	for (const field of ["linkTtlSeconds", "coalesceMs"] as const) {
		const value = config[field];

		if (
			value !== undefined &&
			(!Number.isInteger(value) || (value as number) <= 0)
		) {
			problems.push(`${field} must be a positive whole number.`);
		}
	}

	if (
		config.keyStorage !== undefined &&
		config.keyStorage !== "keychain" &&
		config.keyStorage !== "file"
	) {
		problems.push('keyStorage is "keychain" or "file".');
	}

	return problems;
}

function isUrl(value: unknown, protocols: string[]): value is string {
	if (typeof value !== "string") {
		return false;
	}

	try {
		return protocols.includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

function isLoopback(value: string): boolean {
	const host = new URL(value).hostname;

	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
