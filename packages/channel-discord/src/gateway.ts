/** Gateway opcodes the bot sends or handles. */
export const Op = {
	Dispatch: 0,
	Heartbeat: 1,
	Identify: 2,
	Resume: 6,
	Reconnect: 7,
	InvalidSession: 9,
	Hello: 10,
	HeartbeatAck: 11,
} as const;

/** GUILDS (channel and thread info), GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT. */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Close codes after which reconnecting cannot help: the config (token,
 * intents) has to change. Each with what to do about it.
 */
const FATAL_CLOSES: Record<number, string> = {
	4004: "Discord rejected the bot token. Reset it in the developer portal and update botToken.",
	4010: "Discord refused the shard settings.",
	4011: "The bot is in too many servers to run without sharding.",
	4012: "Discord no longer accepts gateway version 10.",
	4013: "Discord refused the gateway intents.",
	4014: "The bot asked for the Message Content intent, which is not enabled for it. In the developer portal, open the application → Bot → Privileged Gateway Intents and turn on Message Content Intent.",
};

/** Close codes after which the session cannot be resumed; identify afresh. */
const NEW_SESSION_CLOSES = new Set([4007, 4009]);

export interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number | null;
	t?: string | null;
}

export interface GatewaySocket {
	send(data: string): void;
	close(code: number, reason?: string): void;
}

export interface SocketHandlers {
	message(data: string): void;
	close(code: number, reason: string): void;
}

export type SocketFactory = (
	url: string,
	handlers: SocketHandlers,
) => GatewaySocket;

export type Schedule = (callback: () => void, ms: number) => () => void;

export interface GatewayOptions {
	token: string;
	intents?: number;
	/** Where to connect (from GET /gateway/bot); asked again on each new session. */
	gatewayUrl: () => Promise<string>;
	/** An event: MESSAGE_CREATE, INTERACTION_CREATE, READY, … */
	onDispatch: (type: string, data: unknown) => void;
	/** Connected (`ready`) or not, with why; `stopped` when it gave up for good. */
	onStatus: (state: "ready" | "degraded" | "stopped", message?: string) => void;
	createSocket?: SocketFactory;
	schedule?: Schedule;
	random?: () => number;
}

export const defaultSchedule: Schedule = (callback, ms) => {
	const timer = setTimeout(callback, ms);
	(timer as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
};

export const webSocketFactory: SocketFactory = (url, handlers) => {
	const socket = new WebSocket(url);

	socket.onmessage = (event) => {
		handlers.message(
			typeof event.data === "string"
				? event.data
				: Buffer.from(event.data as ArrayBuffer).toString("utf8"),
		);
	};
	// An error is followed by a close; the close is what is acted on.
	socket.onerror = () => undefined;
	socket.onclose = (event) => handlers.close(event.code, event.reason);

	return {
		send: (data) => socket.send(data),
		close: (code, reason) => socket.close(code, reason),
	};
};

/**
 * One connection to Discord's Gateway, kept up: HELLO, then IDENTIFY (or
 * RESUME of the last session, so no event is missed), heartbeats at the
 * interval Discord gives, and a reconnect when Discord asks for one, a
 * heartbeat goes unanswered, or the socket drops. Gives up only on close
 * codes that mean the config is wrong.
 */
export class DiscordGateway {
	private socket?: GatewaySocket;
	/** Which socket is current; events of an older one are ignored. */
	private generation = 0;
	private sequence: number | null = null;
	private sessionId?: string;
	private resumeUrl?: string;
	private heartbeatAcked = true;
	private cancelHeartbeat?: () => void;
	private cancelReconnect?: () => void;
	private reconnectAttempt = 0;
	private stopped = false;
	private readonly createSocket: SocketFactory;
	private readonly schedule: Schedule;
	private readonly random: () => number;

	public constructor(private readonly options: GatewayOptions) {
		this.createSocket = options.createSocket ?? webSocketFactory;
		this.schedule = options.schedule ?? defaultSchedule;
		this.random = options.random ?? Math.random;
	}

	public get canResume(): boolean {
		return this.sessionId !== undefined && this.sequence !== null;
	}

	/** Connect, and keep connecting until it works or `stop` is called. */
	public start(): void {
		this.stopped = false;
		this.scheduleConnect(0);
	}

	public async connect(): Promise<void> {
		this.stopped = false;
		const resuming = this.canResume && this.resumeUrl !== undefined;
		const base = resuming
			? (this.resumeUrl as string)
			: await this.options.gatewayUrl();

		if (this.stopped) {
			return;
		}

		const generation = ++this.generation;
		this.heartbeatAcked = true;
		this.socket = this.createSocket(
			`${base.replace(/\/+$/, "")}/?v=10&encoding=json`,
			{
				message: (data) => {
					if (generation === this.generation) {
						this.onMessage(data);
					}
				},
				close: (code, reason) => {
					if (generation === this.generation) {
						this.onClose(code, reason);
					}
				},
			},
		);
	}

	public stop(): void {
		this.stopped = true;
		this.cancelHeartbeat?.();
		this.cancelReconnect?.();
		this.generation += 1;
		// 1000 ends the session: the bot shows as offline at once.
		this.socket?.close(1000, "stopping");
		this.socket = undefined;
	}

	private send(payload: GatewayPayload): void {
		this.socket?.send(JSON.stringify(payload));
	}

	private onMessage(data: string): void {
		let payload: GatewayPayload;

		try {
			payload = JSON.parse(data) as GatewayPayload;
		} catch {
			return;
		}

		if (typeof payload.s === "number") {
			this.sequence = payload.s;
		}

		switch (payload.op) {
			case Op.Hello:
				this.onHello(payload.d as { heartbeat_interval: number });
				return;
			case Op.HeartbeatAck:
				this.heartbeatAcked = true;
				return;
			case Op.Heartbeat:
				this.send({ op: Op.Heartbeat, d: this.sequence });
				return;
			case Op.Reconnect:
				this.reconnect(true);
				return;
			case Op.InvalidSession:
				if (payload.d !== true) {
					this.forgetSession();
				}
				// Discord asks for a wait of 1–5 s before identifying again.
				this.reconnect(payload.d === true, 1_000 + this.random() * 4_000);
				return;
			case Op.Dispatch:
				this.onDispatch(payload.t ?? "", payload.d);
				return;
			default:
				return;
		}
	}

	private onHello(hello: { heartbeat_interval: number }): void {
		const interval = hello.heartbeat_interval;

		this.cancelHeartbeat?.();
		// The first beat at a random point of the interval, as Discord asks,
		// so bots that reconnect together do not beat together.
		this.beatAfter(interval * this.random(), interval);

		if (this.canResume) {
			this.send({
				op: Op.Resume,
				d: {
					token: this.options.token,
					session_id: this.sessionId,
					seq: this.sequence,
				},
			});
			return;
		}

		this.send({
			op: Op.Identify,
			d: {
				token: this.options.token,
				intents: this.options.intents ?? INTENTS,
				properties: {
					os: process.platform,
					browser: "acpantenna",
					device: "acpantenna",
				},
			},
		});
	}

	private beatAfter(delay: number, interval: number): void {
		this.cancelHeartbeat = this.schedule(() => {
			if (!this.heartbeatAcked) {
				// No answer to the last beat: the connection is a zombie.
				this.options.onStatus(
					"degraded",
					"Discord stopped answering heartbeats; reconnecting.",
				);
				this.reconnect(true);
				return;
			}

			this.heartbeatAcked = false;
			this.send({ op: Op.Heartbeat, d: this.sequence });
			this.beatAfter(interval, interval);
		}, delay);
	}

	private onDispatch(type: string, data: unknown): void {
		if (type === "READY") {
			const ready = data as { session_id: string; resume_gateway_url?: string };
			this.sessionId = ready.session_id;
			this.resumeUrl = ready.resume_gateway_url;
			this.reconnectAttempt = 0;
			this.options.onStatus("ready");
		} else if (type === "RESUMED") {
			this.reconnectAttempt = 0;
			this.options.onStatus("ready");
		}

		this.options.onDispatch(type, data);
	}

	private onClose(code: number, reason: string): void {
		this.cancelHeartbeat?.();
		this.socket = undefined;

		if (this.stopped) {
			return;
		}

		const fatal = FATAL_CLOSES[code];

		if (fatal) {
			this.stopped = true;
			this.options.onStatus("stopped", fatal);
			return;
		}

		if (NEW_SESSION_CLOSES.has(code)) {
			this.forgetSession();
		}

		this.options.onStatus(
			"degraded",
			`Lost the connection to Discord (${code}${reason ? ` ${reason}` : ""}); reconnecting.`,
		);
		this.scheduleConnect(this.backoff());
	}

	/**
	 * Drop this socket and connect again. Closing with a code other than
	 * 1000/1001 keeps the session, so it can be resumed.
	 */
	private reconnect(resume: boolean, delayMs?: number): void {
		this.cancelHeartbeat?.();
		this.generation += 1;
		this.socket?.close(resume ? 4000 : 1000, "reconnecting");
		this.socket = undefined;

		if (!resume) {
			this.forgetSession();
		}

		this.scheduleConnect(delayMs ?? 0);
	}

	private scheduleConnect(delayMs: number): void {
		this.cancelReconnect?.();
		this.cancelReconnect = this.schedule(() => {
			this.cancelReconnect = undefined;
			this.connect().catch((error) => {
				this.options.onStatus(
					"degraded",
					`Can't reach Discord (${error instanceof Error ? error.message : String(error)}); retrying.`,
				);
				this.scheduleConnect(this.backoff());
			});
		}, delayMs);
	}

	private backoff(): number {
		const delay =
			RECONNECT_DELAYS_MS[
				Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
			] ?? 60_000;
		this.reconnectAttempt += 1;
		return delay;
	}

	private forgetSession(): void {
		this.sessionId = undefined;
		this.resumeUrl = undefined;
		this.sequence = null;
	}
}
