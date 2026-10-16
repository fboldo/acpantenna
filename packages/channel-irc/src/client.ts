import type { ChannelLogger } from "@acpantenna/channel";
import { AccountTracker } from "./accounts.ts";
import { IrcSetupError } from "./errors.ts";
import { defaultSchedule, type Schedule, SendQueue } from "./flood.ts";
import {
	applyIsupport,
	casefold,
	DEFAULT_FEATURES,
	formatLine,
	formatText,
	type IrcMessage,
	type IrcSource,
	isChannelName,
	parseCapList,
	parseLine,
	parseSource,
	type ServerFeatures,
	saslPlainLines,
} from "./protocol.ts";
import type { Connect, IrcSocket } from "./socket.ts";
import { textBudget } from "./split.ts";

export interface IrcClientOptions {
	host: string;
	port: number;
	tls: boolean;
	tlsVerify: boolean;
	nick: string;
	username: string;
	realname: string;
	account: string;
	password?: string;
	nickserv: boolean;
	serverPassword?: string;
	channels: Array<{ name: string; key?: string }>;
	sendBurst: number;
	sendIntervalMs: number;
	connect: Connect;
	logger: ChannelLogger;
	schedule?: Schedule;
	now?: () => number;
	random?: () => number;
}

/** A PRIVMSG or NOTICE someone sent, to the bot or a channel it is in. */
export interface IrcIncoming {
	command: "PRIVMSG" | "NOTICE";
	/** The channel, or the bot's nick for a private message. */
	target: string;
	text: string;
	/** A CTCP ACTION (`/me …`). */
	action: boolean;
	source: IrcSource;
	/** The sender's services account, when the server vouches for one. */
	account?: string;
	tags: Record<string, string>;
}

export type IrcClientState = "starting" | "ready" | "degraded" | "stopped";

export interface IrcClientEvents {
	message(message: IrcIncoming): void;
	state(state: IrcClientState, message?: string): void;
}

/** Capabilities asked for when the server offers them. */
const WANTED_CAPS = [
	"account-tag",
	"account-notify",
	"extended-join",
	"message-tags",
	"cap-notify",
];
const REGISTRATION_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const PING_AFTER_MS = 90_000;
const DEAD_AFTER_MS = 240_000;
const NICK_REGAIN_MS = 60_000;
const REJOIN_AFTER_KICK_MS = 15_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 300_000;
/** A server line longer than this without a line break is not one. */
const MAX_BUFFER_CHARS = 64 * 1024;
const WHOX_TOKEN = "42";
/** What a CTCP request (`/me` among them) is wrapped in. */
const CTCP = "\u0001";

/**
 * One connection to an IRC server, kept up: registration with IRCv3
 * capabilities and SASL PLAIN, PING/PONG both ways, nick collisions, joins,
 * and reconnecting with backoff. Lines go out through a token bucket.
 */
export class IrcClient {
	private socket?: IrcSocket;
	private readonly queue: SendQueue;
	private readonly schedule: Schedule;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly accounts = new AccountTracker();
	private features: ServerFeatures = DEFAULT_FEATURES;
	private caps = new Set<string>();
	private offeredCaps = new Map<string, string>();
	private currentNick: string;
	private nickAttempt = 0;
	private userHost?: string;
	private registered = false;
	private saslDone = false;
	private capNegotiating = false;
	private stopping = false;
	private fatal?: IrcSetupError;
	private attempt = 0;
	private lastSeen = 0;
	private pingSent = false;
	private lastRegainAt = 0;
	private readonly joined = new Set<string>();
	private readonly timers = new Set<() => void>();
	private reconnectCancel?: () => void;
	private started?: { resolve: () => void; reject: (error: Error) => void };

	public constructor(
		private readonly options: IrcClientOptions,
		private readonly events: IrcClientEvents,
	) {
		this.schedule = options.schedule ?? defaultSchedule;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.currentNick = options.nick;
		this.queue = new SendQueue({
			write: (line) => this.write(line),
			burst: options.sendBurst,
			intervalMs: options.sendIntervalMs,
			schedule: this.schedule,
			now: this.now,
		});
	}

	public get nick(): string {
		return this.currentNick;
	}

	/** Every nick a message may address the bot by. */
	public get nicks(): string[] {
		return [...new Set([this.currentNick, this.options.nick])];
	}

	public get ready(): boolean {
		return this.registered && this.socket !== undefined;
	}

	public get caseMapping(): ServerFeatures["caseMapping"] {
		return this.features.caseMapping;
	}

	public get chanTypes(): string {
		return this.features.chanTypes;
	}

	public get enabledCaps(): ReadonlySet<string> {
		return this.caps;
	}

	public isChannel(target: string): boolean {
		return isChannelName(target, this.features.chanTypes);
	}

	public fold(name: string): string {
		return casefold(name, this.features.caseMapping);
	}

	/** Bytes of text that fit in one PRIVMSG / NOTICE to `target`. */
	public budget(command: "PRIVMSG" | "NOTICE", target: string): number {
		return textBudget(
			{
				nick: this.currentNick,
				userHost: this.userHost,
				userLen: Math.max(this.features.userLen, this.options.username.length),
				hostLen: this.features.hostLen,
			},
			command,
			target,
		);
	}

	/**
	 * Connect and register. Resolves once registered, or once the first try
	 * failed for a reason worth retrying (it goes on in the background);
	 * rejects with an `IrcSetupError` for one that is not.
	 */
	public start(): Promise<void> {
		this.stopping = false;

		return new Promise((resolve, reject) => {
			this.started = { resolve, reject };
			void this.connect();
		});
	}

	public stop(): void {
		this.stopping = true;
		this.reconnectCancel?.();

		for (const cancel of this.timers) {
			cancel();
		}

		this.timers.clear();

		if (this.socket) {
			this.queue.clear();
			this.write(formatLine("QUIT", "Bye"));
			this.socket.end();
		}

		this.socket = undefined;
		this.setState("stopped");
	}

	public privmsg(target: string, text: string): void {
		this.queue.push(formatText("PRIVMSG", target, text));
	}

	public notice(target: string, text: string): void {
		this.queue.push(formatText("NOTICE", target, text));
	}

	/** Lines waiting for the flood limit. */
	public get backlog(): number {
		return this.queue.pending;
	}

	private async connect(): Promise<void> {
		const { host, port, tls, tlsVerify } = this.options;
		this.setState(this.attempt === 0 ? "starting" : "degraded");

		let socket: IrcSocket;

		try {
			socket = await this.options.connect({
				host,
				port,
				tls,
				tlsVerify,
				timeoutMs: CONNECT_TIMEOUT_MS,
			});
		} catch (error) {
			this.connectionLost(describeSocketError(error, host, port));
			return;
		}

		if (this.stopping) {
			socket.end();
			return;
		}

		this.socket = socket;
		this.resetSession();
		this.lastSeen = this.now();

		const decoder = new TextDecoder();
		let buffer = "";

		socket.onData((chunk) => {
			if (this.socket !== socket) {
				return;
			}

			buffer += decoder.decode(chunk, { stream: true });

			let newline = buffer.indexOf("\n");

			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				this.receive(line);
				newline = buffer.indexOf("\n");
			}

			if (buffer.length > MAX_BUFFER_CHARS) {
				buffer = "";
			}
		});
		socket.onClose((error) => {
			if (this.socket !== socket) {
				return;
			}

			this.socket = undefined;
			this.queue.clear();
			this.connectionLost(
				error
					? describeSocketError(error, host, port)
					: `The connection to ${host} closed.`,
			);
		});

		this.urgent(formatLine("CAP", "LS", "302"));
		this.capNegotiating = true;

		if (this.options.serverPassword) {
			this.urgent(formatLine("PASS", this.options.serverPassword));
		}

		this.urgent(formatLine("NICK", this.currentNick));
		this.urgent(
			formatLine(
				"USER",
				this.options.username,
				"0",
				"*",
				this.options.realname,
			),
		);

		this.after(REGISTRATION_TIMEOUT_MS, () => {
			if (this.socket === socket && !this.registered) {
				this.options.logger.warn("IRC registration timed out.", { host });
				socket.end();
			}
		});
		this.keepAlive(socket);
	}

	private resetSession(): void {
		this.registered = false;
		this.saslDone = false;
		this.caps = new Set();
		this.offeredCaps = new Map();
		this.features = DEFAULT_FEATURES;
		this.currentNick = this.options.nick;
		this.nickAttempt = 0;
		this.userHost = undefined;
		this.joined.clear();
		this.accounts.clear();
		this.pingSent = false;
	}

	private connectionLost(reason: string): void {
		this.registered = false;

		if (this.stopping) {
			return;
		}

		if (this.fatal) {
			this.setState("stopped", this.fatal.message);
			this.settleStart(this.fatal);
			return;
		}

		this.setState("degraded", reason);
		this.options.logger.warn("IRC connection lost; reconnecting.", { reason });
		this.settleStart();

		const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt);
		const delay = Math.round(base * (0.5 + this.random() / 2));
		this.attempt += 1;
		this.reconnectCancel = this.schedule(() => {
			this.reconnectCancel = undefined;
			void this.connect();
		}, delay);
	}

	/** A setup problem: say why, close, and do not come back. */
	private fail(message: string): void {
		this.fatal = new IrcSetupError(message);
		this.options.logger.error(message);
		this.socket?.end();
	}

	private settleStart(error?: Error): void {
		const started = this.started;
		this.started = undefined;

		if (error) {
			started?.reject(error);
		} else {
			started?.resolve();
		}
	}

	private keepAlive(socket: IrcSocket): void {
		const tick = () => {
			if (this.socket !== socket) {
				return;
			}

			const quiet = this.now() - this.lastSeen;

			if (quiet > DEAD_AFTER_MS) {
				this.options.logger.warn("IRC server stopped answering.", {
					quietMs: quiet,
				});
				socket.end();
				return;
			}

			if (quiet > PING_AFTER_MS && !this.pingSent) {
				this.pingSent = true;
				this.urgent(formatLine("PING", "acpantenna"));
			}

			if (
				this.registered &&
				this.fold(this.currentNick) !== this.fold(this.options.nick) &&
				this.now() - this.lastRegainAt >= NICK_REGAIN_MS
			) {
				// Whoever had the nick may have gone: ask for it back.
				this.lastRegainAt = this.now();
				this.queue.push(formatLine("NICK", this.options.nick));
			}

			this.after(30_000, tick);
		};

		this.after(30_000, tick);
	}

	private after(ms: number, callback: () => void): void {
		const cancel = this.schedule(() => {
			this.timers.delete(cancel);
			callback();
		}, ms);
		this.timers.add(cancel);
	}

	private write(line: string): void {
		this.socket?.write(`${line}\r\n`);
	}

	private urgent(line: string): void {
		this.queue.urgent(line);
	}

	private setState(state: IrcClientState, message?: string): void {
		this.events.state(state, message);
	}

	/** One line from the server. */
	public receive(line: string): void {
		const message = parseLine(line);

		this.lastSeen = this.now();
		this.pingSent = false;

		if (!message) {
			return;
		}

		try {
			this.handle(message);
		} catch (error) {
			this.options.logger.warn("Could not handle an IRC line.", {
				command: message.command,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private handle(message: IrcMessage): void {
		const { command, params } = message;
		const source = parseSource(message.prefix);
		const fromSelf =
			source.nick !== "" &&
			this.fold(source.nick) === this.fold(this.currentNick);

		switch (command) {
			case "PING":
				this.urgent(formatLine("PONG", params[0] ?? ""));
				return;
			case "CAP":
				this.onCap(params);
				return;
			case "AUTHENTICATE":
				if (params[0] === "+" && this.options.password) {
					for (const piece of saslPlainLines(
						this.options.account,
						this.options.password,
					)) {
						this.urgent(piece);
					}
				}
				return;
			case "900":
				return;
			case "903":
				this.saslDone = true;
				this.endCap();
				return;
			case "907":
				this.saslDone = true;
				this.endCap();
				return;
			case "902":
			case "904":
			case "905":
			case "908":
				this.fail(
					`SASL login failed for account ${this.options.account}: ${params.at(-1) ?? command}. Check account and password.`,
				);
				return;
			case "906":
				return;
			case "001":
				this.onWelcome(params);
				return;
			case "005":
				this.features = applyIsupport(this.features, params.slice(1, -1));
				this.accounts.setCaseMapping(this.features.caseMapping);
				return;
			case "396":
				if (params[1]) {
					const user =
						this.userHost?.split("@")[0] ?? `~${this.options.username}`;
					this.userHost = `${user}@${params[1]}`;
				}
				return;
			case "432":
				if (!this.registered) {
					this.fail(
						`The server refused the nick ${params[1] ?? this.currentNick}: ${params.at(-1)}`,
					);
				}
				return;
			case "433":
			case "436":
			case "437":
				if (!this.registered) {
					this.nextNick();
				}
				return;
			case "464":
				this.fail("The server rejected serverPassword.");
				return;
			case "465":
				this.options.logger.error("The server bans the bot.", {
					reason: params.at(-1),
				});
				return;
			case "471":
			case "473":
			case "474":
			case "475":
			case "477":
				this.options.logger.warn("Could not join an IRC channel.", {
					channel: params[1],
					reason: params.at(-1),
				});
				return;
			case "354":
				// WHO <channel> %tcna: token, channel, nick, account.
				if (params[1] === WHOX_TOKEN && params[2] && params[3] && params[4]) {
					this.accounts.joined(params[3], params[2], params[4]);
				}
				return;
			case "JOIN":
				this.onJoin(source, params, fromSelf, message.prefix);
				return;
			case "PART":
				if (fromSelf) {
					this.leftChannel(params[0] ?? "");
				} else if (params[0]) {
					this.accounts.parted(source.nick, params[0]);
				}
				return;
			case "KICK":
				this.onKick(params);
				return;
			case "QUIT":
				this.accounts.forget(source.nick);
				return;
			case "NICK":
				if (fromSelf) {
					this.currentNick = params[0] ?? this.currentNick;
					this.options.logger.info("IRC nick changed.", {
						nick: this.currentNick,
					});
				} else if (params[0]) {
					this.accounts.renamed(source.nick, params[0]);
				}
				return;
			case "ACCOUNT":
				if (params[0]) {
					this.accounts.set(source.nick, params[0]);
				}
				return;
			case "PRIVMSG":
			case "NOTICE":
				this.onMessage(message, source, fromSelf);
				return;
			case "ERROR":
				this.options.logger.warn("The IRC server closed the link.", {
					reason: params[0],
				});
				return;
			default:
				return;
		}
	}

	private onCap(params: string[]): void {
		const sub = params[1]?.toUpperCase();

		if (sub === "LS") {
			const more = params[2] === "*";
			const list = (more ? params[3] : params[2]) ?? "";

			for (const [name, value] of parseCapList(list)) {
				this.offeredCaps.set(name, value);
			}

			if (more || !this.capNegotiating) {
				return;
			}

			const wanted = WANTED_CAPS.filter((cap) => this.offeredCaps.has(cap));

			if (this.options.password && !this.options.nickserv) {
				const sasl = this.offeredCaps.get("sasl");

				if (sasl === undefined) {
					this.fail(
						"The server does not offer SASL. Set nickserv: true to identify through NickServ instead, or leave the password empty.",
					);
					return;
				}

				if (sasl !== "" && !sasl.split(",").includes("PLAIN")) {
					this.fail(`The server offers SASL ${sasl}, not PLAIN.`);
					return;
				}

				wanted.push("sasl");
			} else if (this.options.password && this.offeredCaps.has("sasl")) {
				wanted.push("sasl");
			}

			if (wanted.length === 0) {
				this.endCap();
				return;
			}

			this.urgent(formatLine("CAP", "REQ", wanted.join(" ")));
			return;
		}

		if (sub === "ACK") {
			const acked = (params[2] ?? "").split(" ").filter(Boolean);

			for (const cap of acked) {
				if (cap.startsWith("-")) {
					this.caps.delete(cap.slice(1));
				} else {
					this.caps.add(cap);
				}
			}

			if (!this.capNegotiating) {
				return;
			}

			if (this.caps.has("sasl") && this.options.password && !this.saslDone) {
				this.urgent(formatLine("AUTHENTICATE", "PLAIN"));
				return;
			}

			this.endCap();
			return;
		}

		if (sub === "NAK") {
			if (this.capNegotiating) {
				if (this.options.password && !this.options.nickserv) {
					this.fail(
						"The server refused the capabilities asked for, SASL among them.",
					);
					return;
				}

				this.endCap();
			}

			return;
		}

		if (sub === "DEL") {
			for (const cap of (params[2] ?? "").split(" ")) {
				this.caps.delete(cap);
			}

			if (!this.caps.has("account-notify")) {
				this.accounts.clear();
			}
		}
	}

	private endCap(): void {
		if (this.capNegotiating) {
			this.capNegotiating = false;
			this.urgent(formatLine("CAP", "END"));
		}
	}

	private onWelcome(params: string[]): void {
		this.capNegotiating = false;
		this.currentNick = params[0] ?? this.currentNick;

		if (this.options.password && !this.saslDone) {
			if (!this.options.nickserv) {
				this.fail(
					"The server does not do SASL. Set nickserv: true to identify through NickServ instead, or leave the password empty.",
				);
				return;
			}

			// The account first, so a server that checks the nick has it.
			this.queue.push(
				formatLine(
					"PRIVMSG",
					"NickServ",
					`IDENTIFY ${this.options.account} ${this.options.password}`,
				),
			);
		}

		this.registered = true;
		this.attempt = 0;
		this.options.logger.info("Connected to IRC.", {
			server: this.options.host,
			nick: this.currentNick,
			caps: [...this.caps],
		});

		for (const channel of this.options.channels) {
			this.queue.push(
				channel.key
					? formatLine("JOIN", channel.name, channel.key)
					: formatLine("JOIN", channel.name),
			);
		}

		this.setState("ready");
		this.settleStart();
	}

	private nextNick(): void {
		this.nickAttempt += 1;
		const base = this.options.nick.slice(
			0,
			Math.max(1, this.features.nickLen - 3),
		);
		const nick =
			this.nickAttempt === 1
				? `${base}_`
				: `${base}${Math.floor(this.random() * 900 + 100)}`;

		this.options.logger.warn("IRC nick in use; trying another.", {
			wanted: this.options.nick,
			trying: nick,
		});
		this.currentNick = nick;
		this.urgent(formatLine("NICK", nick));
	}

	private onJoin(
		source: IrcSource,
		params: string[],
		fromSelf: boolean,
		prefix: string,
	): void {
		const channel = params[0];

		if (!channel) {
			return;
		}

		if (fromSelf) {
			this.joined.add(this.fold(channel));

			if (source.user && source.host) {
				this.userHost = prefix.slice(prefix.indexOf("!") + 1);
			}

			this.options.logger.info("Joined IRC channel.", { channel });

			if (this.features.whox && this.caps.has("account-notify")) {
				this.queue.push(formatLine("WHO", channel, `%tcna,${WHOX_TOKEN}`));
			}

			return;
		}

		const account = this.caps.has("extended-join") ? params[1] : undefined;
		this.accounts.joined(source.nick, channel, account);
	}

	private onKick(params: string[]): void {
		const [channel, kicked] = params;

		if (!channel || !kicked) {
			return;
		}

		if (this.fold(kicked) !== this.fold(this.currentNick)) {
			this.accounts.parted(kicked, channel);
			return;
		}

		this.options.logger.warn("Kicked from an IRC channel.", {
			channel,
			reason: params[2],
		});
		this.leftChannel(channel);

		const configured = this.options.channels.find(
			(entry) => this.fold(entry.name) === this.fold(channel),
		);

		if (configured) {
			this.after(REJOIN_AFTER_KICK_MS, () => {
				if (this.ready && !this.joined.has(this.fold(channel))) {
					this.queue.push(
						configured.key
							? formatLine("JOIN", configured.name, configured.key)
							: formatLine("JOIN", configured.name),
					);
				}
			});
		}
	}

	private leftChannel(channel: string): void {
		this.joined.delete(this.fold(channel));
		this.accounts.leftChannel(channel);
	}

	private onMessage(
		message: IrcMessage,
		source: IrcSource,
		fromSelf: boolean,
	): void {
		const [target, rawText = ""] = message.params;

		// Lines from the server itself, and the bot's own echoes, are not chat.
		if (!target || !source.user || fromSelf) {
			return;
		}

		let text = rawText;
		let action = false;

		if (text.startsWith(CTCP)) {
			const ctcp = text.slice(1, text.endsWith(CTCP) ? -1 : undefined);

			if (!ctcp.toUpperCase().startsWith("ACTION ")) {
				return;
			}

			action = true;
			text = ctcp.slice("ACTION ".length);
		}

		this.events.message({
			command: message.command as "PRIVMSG" | "NOTICE",
			target,
			text,
			action,
			source,
			account: this.accountOf(source.nick, message.tags),
			tags: message.tags,
		});
	}

	/**
	 * The services account behind a message: the `account` tag where the
	 * server sends it (its absence then means not logged in), else what
	 * `account-notify` has kept track of. Otherwise nobody vouches for one.
	 */
	private accountOf(
		nick: string,
		tags: Record<string, string>,
	): string | undefined {
		if (this.caps.has("account-tag")) {
			const tagged = tags.account;
			return tagged && tagged !== "*" ? tagged : undefined;
		}

		if (this.caps.has("account-notify")) {
			return this.accounts.get(nick) ?? undefined;
		}

		return undefined;
	}
}

function describeSocketError(
	error: unknown,
	host: string,
	port: number,
): string {
	const candidate = (error ?? {}) as { code?: string; message?: string };
	const where = `${host}:${port}`;

	switch (candidate.code) {
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return `Can't find the IRC server ${host}; retrying.`;
		case "ECONNREFUSED":
			return `${where} refused the connection; retrying.`;
		case "ETIMEDOUT":
			return `Timed out connecting to ${where}; retrying.`;
		case "DEPTH_ZERO_SELF_SIGNED_CERT":
		case "SELF_SIGNED_CERT_IN_CHAIN":
		case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
		case "CERT_HAS_EXPIRED":
		case "ERR_TLS_CERT_ALTNAME_INVALID":
			return `${host}'s TLS certificate does not check out (${candidate.code}); retrying.`;
		default:
			return `${candidate.message ?? String(error)} (${where}); retrying.`;
	}
}
