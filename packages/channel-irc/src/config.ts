import type { ChannelConfigSchema } from "@acpantenna/channel";
import type { InboundPolicy } from "./inbound.ts";

export const DEFAULT_TLS_PORT = 6697;
export const DEFAULT_PLAIN_PORT = 6667;
export const DEFAULT_REALNAME = "acpantenna";
export const DEFAULT_MAX_LINES = 10;
export const DEFAULT_SEND_BURST = 4;
export const DEFAULT_SEND_INTERVAL_MS = 1000;

export interface IrcChannelConfig {
	type: "irc";
	/** The server's host name, like irc.libera.chat. */
	server: string;
	/** Default 6697 with TLS, 6667 without. */
	port?: number;
	/** Default true. */
	tls?: boolean;
	/** Check the server's TLS certificate. Default true. */
	tlsVerify?: boolean;
	nick: string;
	/** The user name (ident). Default the nick. */
	username?: string;
	realname?: string;
	/** The services account to log in to. Default the nick. */
	account?: string;
	/** The account's password, for SASL PLAIN (or NickServ). */
	password?: string;
	/** Without SASL on the server: IDENTIFY to NickServ with `password`. Default false. */
	nickserv?: boolean;
	/** The server password (PASS), for servers and bouncers that want one. */
	serverPassword?: string;
	/** Channels to join: `#name`, or `#name key` for one with a key. */
	channels?: string[];
	/** In a channel: answer only when addressed (`nick: …`), or every message. */
	respond?: "mention" | "always";
	/** Most lines one reply sends before the rest waits for "more". 0: no limit. */
	maxLines?: number;
	/** Lines sent at once before the bot slows down. Default 4. */
	sendBurst?: number;
	/** Then one line every this many ms. Default 1000. */
	sendIntervalMs?: number;
	/** Show tool calls as short notices. Default true. */
	showToolCalls?: boolean;
	/** Generic channel fields the gateway resolves; read, not owned, here. */
	permissions?: {
		inbound?: InboundPolicy;
		interactionTimeoutSeconds?: number;
	};
	delivery?: { mode?: string };
}

export const IRC_CONFIG_SCHEMA: ChannelConfigSchema = {
	type: "object",
	properties: {
		server: {
			type: "string",
			title: "Server",
			description: "The IRC server's host name, e.g. irc.libera.chat.",
		},
		nick: {
			type: "string",
			title: "Nick",
			description:
				"The bot's nick. Register it with the network's services so nobody else can take it.",
		},
		password: {
			type: "string",
			title: "Account password",
			description:
				"The bot's services account password, sent with SASL PLAIN over TLS. Leave empty for a bot without an account.",
			secret: true,
		},
		channels: {
			type: "array",
			title: "Channels",
			description:
				"Channels to join, comma-separated: #name, or “#name key” for a channel with a key. Private messages work without any.",
			items: { type: "string" },
		},
		port: {
			type: "integer",
			title: "Port",
			description: "Default 6697 with TLS, 6667 without.",
		},
		tls: {
			type: "boolean",
			title: "TLS",
			description:
				"Connect with TLS. Turn off only for a server on this machine.",
			default: true,
		},
		tlsVerify: {
			type: "boolean",
			title: "Verify the TLS certificate",
			description: "Refuse a server whose certificate does not check out.",
			default: true,
		},
		account: {
			type: "string",
			title: "Account name",
			description:
				"The services account to log in to, when it is not the nick.",
		},
		nickserv: {
			type: "boolean",
			title: "NickServ fallback",
			description:
				"On a server without SASL, identify to NickServ with the password instead (sent as a private message).",
			default: false,
		},
		serverPassword: {
			type: "string",
			title: "Server password",
			description:
				"A password for the server itself (PASS), for bouncers and private servers.",
			secret: true,
		},
		username: {
			type: "string",
			title: "User name",
			description:
				"The user name (ident) shown in nick!user@host. Default the nick.",
		},
		realname: {
			type: "string",
			title: "Real name",
			default: DEFAULT_REALNAME,
		},
		respond: {
			type: "string",
			title: "In a channel, answer",
			description:
				"mention: only messages addressed to the bot (“nick: …”). always: every message from an allowed sender.",
			enum: ["mention", "always"],
			default: "mention",
		},
		maxLines: {
			type: "integer",
			title: "Most lines per reply",
			description:
				"A longer reply sends this many lines, then waits for “more”. 0 sends everything.",
			default: DEFAULT_MAX_LINES,
		},
		sendBurst: {
			type: "integer",
			title: "Lines at once",
			description:
				"Lines sent together before the bot slows down to the rate below.",
			default: DEFAULT_SEND_BURST,
		},
		sendIntervalMs: {
			type: "integer",
			title: "Line interval (ms)",
			description:
				"Then one line every this many ms. Servers disconnect clients that flood.",
			default: DEFAULT_SEND_INTERVAL_MS,
		},
		showToolCalls: {
			type: "boolean",
			title: "Show tool calls",
			description: "Show the agent's tool calls as short notices.",
			default: true,
		},
	},
	required: ["server", "nick"],
};

export function resolvePort(config: Partial<IrcChannelConfig>): number {
	return (
		config.port ??
		(config.tls === false ? DEFAULT_PLAIN_PORT : DEFAULT_TLS_PORT)
	);
}

const NICK = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]*$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** The fields the channel cannot start without, as a readable list of problems. */
export function configProblems(config: Partial<IrcChannelConfig>): string[] {
	const problems: string[] = [];

	if (!config.server || /[\s/]/.test(config.server)) {
		problems.push("server must be a host name, like irc.libera.chat.");
	}

	const port = resolvePort(config);

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		problems.push("port must be a whole number from 1 to 65535.");
	}

	if (!config.nick || !NICK.test(config.nick)) {
		problems.push(
			"nick must be an IRC nick: letters, digits and []\\`_^{|}-, not starting with a digit or -.",
		);
	}

	if (config.username !== undefined && !/^[^\s@!]+$/.test(config.username)) {
		problems.push("username must be one word, without @ or !.");
	}

	for (const entry of config.channels ?? []) {
		if (!/^[#&+!][^\s,]+( \S+)?$/.test(entry.trim())) {
			problems.push(`channels: "${entry}" is not “#name” or “#name key”.`);
		}
	}

	if (
		config.respond &&
		config.respond !== "mention" &&
		config.respond !== "always"
	) {
		problems.push('respond must be "mention" or "always".');
	}

	if (
		config.maxLines !== undefined &&
		(!Number.isInteger(config.maxLines) || config.maxLines < 0)
	) {
		problems.push("maxLines must be a whole number, 0 or more.");
	}

	if (
		(config.password || config.serverPassword) &&
		config.tls === false &&
		!LOCAL_HOSTS.has(config.server ?? "")
	) {
		problems.push(
			"A password would be sent in the clear: turn tls on (or connect to a server on this machine).",
		);
	}

	if (config.nickserv && !config.password) {
		problems.push("nickserv needs the account password.");
	}

	return problems;
}

/** `#name key` as its parts. */
export function parseChannelEntry(entry: string): {
	name: string;
	key?: string;
} {
	const [name = "", key] = entry.trim().split(/\s+/, 2);
	return key ? { name, key } : { name };
}
