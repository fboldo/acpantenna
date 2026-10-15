import type { ChannelConfigSchema } from "@acpantenna/channel";
import type { InboundPolicy } from "./inbound.ts";

export const DEFAULT_HOMESERVER_URL = "https://matrix.org";
export const DEFAULT_DEVICE_NAME = "acpantenna";

export interface MatrixChannelConfig {
	type: "matrix";
	/** The bot account's homeserver. Default https://matrix.org. */
	homeserverUrl?: string;
	/** The bot's Matrix ID, like @mybot:matrix.org. */
	userId: string;
	/** The bot's access token. Exactly one of this and `password`. */
	accessToken?: string;
	/**
	 * The bot's password, to log in once as a new device; the session is kept
	 * in the state dir. Exactly one of this and `accessToken`.
	 */
	password?: string;
	/** The device the token was issued for; asked of the server when unset. */
	deviceId?: string;
	/** Name of the device a password login creates. Default "acpantenna". */
	deviceName?: string;
	/** End-to-end encryption. Default true. */
	encryption?: boolean;
	/** Encrypts the bot's key store on disk. Optional; keep it if you set it. */
	storePassphrase?: string;
	/** Least time between two edits of a streamed message. Default 3000ms. */
	editIntervalMs?: number;
	/** Generic channel fields the gateway resolves; read, not owned, here. */
	permissions?: {
		inbound?: InboundPolicy;
		interactionTimeoutSeconds?: number;
	};
	delivery?: { mode?: string };
}

export const MATRIX_CONFIG_SCHEMA: ChannelConfigSchema = {
	type: "object",
	properties: {
		homeserverUrl: {
			type: "string",
			title: "Homeserver",
			description:
				"The bot account's homeserver, e.g. https://matrix.org or your own server.",
			default: DEFAULT_HOMESERVER_URL,
		},
		userId: {
			type: "string",
			title: "Bot user ID",
			description: "The bot's Matrix ID, like @mybot:matrix.org.",
		},
		password: {
			type: "string",
			title: "Password",
			description:
				"The bot account's password. Fill in this or an access token, not both. The bot logs in once as a new device and keeps that session; the password also lets it set up its encryption identity on servers that ask for it.",
			secret: true,
		},
		accessToken: {
			type: "string",
			title: "Access token",
			description:
				"Instead of a password: an access token for a new device of the bot account, from a password login. Fill in this or a password, not both.",
			secret: true,
		},
		deviceId: {
			type: "string",
			title: "Device ID",
			description:
				"With an access token: the device it belongs to. Leave empty to ask the homeserver.",
		},
		deviceName: {
			type: "string",
			title: "Device name",
			description:
				"With a password: the name of the device the bot logs in as, shown in the account's session list.",
			default: DEFAULT_DEVICE_NAME,
		},
		encryption: {
			type: "boolean",
			title: "End-to-end encryption",
			description:
				"Read and write in encrypted rooms. The bot's keys are kept beside the gateway's state.",
			default: true,
		},
		storePassphrase: {
			type: "string",
			title: "Key store passphrase",
			description:
				"Optional. Encrypts the bot's key store on disk; the bot cannot start without it once set.",
			secret: true,
		},
		editIntervalMs: {
			type: "number",
			title: "Edit interval (ms)",
			description:
				"Least time between edits of a reply as it streams in. Homeservers rate-limit edits like messages.",
			default: 3000,
		},
	},
	// One of password / accessToken as well; a schema cannot say "one of",
	// so configProblems checks it at start.
	required: ["homeserverUrl", "userId"],
};

/** The fields the channel cannot start without, as a readable list of problems. */
export function configProblems(config: Partial<MatrixChannelConfig>): string[] {
	const problems: string[] = [];
	const homeserverUrl = config.homeserverUrl ?? DEFAULT_HOMESERVER_URL;

	try {
		const url = new URL(homeserverUrl);

		if (url.protocol !== "https:" && url.protocol !== "http:") {
			problems.push("homeserverUrl must be an http(s) URL.");
		}
	} catch {
		problems.push(`homeserverUrl is not a URL: ${homeserverUrl}`);
	}

	if (!config.userId || !/^@[^:]+:.+$/.test(config.userId)) {
		problems.push(
			"userId must be the bot's Matrix ID, like @mybot:matrix.org.",
		);
	}

	if (!config.accessToken && !config.password) {
		problems.push("Set the bot's password (or an access token).");
	} else if (config.accessToken && config.password) {
		problems.push(
			"Set either the bot's password or an access token, not both.",
		);
	}

	return problems;
}
