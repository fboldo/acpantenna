/**
 * One connection's way to a browser: a room on the relay, the link that
 * opens it, the Noise session once the browser comes, the words the user
 * checks, and then the proxy.
 *
 * The link works once: its psk is spent when the browser's first frame
 * decrypts (key confirmation), and a message 1 seen before is refused. It
 * stops working when it expires, if no browser has paired by then. The
 * browser gets ACP only after the user has confirmed the words here.
 */

import type {
	ChannelAcpClient,
	ChannelAcpConnection,
	ChannelLogger,
	ChannelPairing,
} from "@acpantenna/channel";
import {
	type CloseEvent,
	EphemeralCache,
	encodeLink,
	type KeyPair,
	parseRelayStatus,
	type RelayHello,
	type RelaySession,
	randomBytes,
	responder,
	roomId,
	roomPath,
} from "@acpantenna/relay-protocol";
import { AcpProxy, refusal } from "./proxy.ts";

/** Time to compare the words once the browser has paired, at least. */
const VERIFY_GRACE_MS = 2 * 60_000;
/** A PING this often keeps the way through the relay open. */
const KEEPALIVE_MS = 30_000;
/** Failed handshakes a link takes before it is given up. */
const MAX_FAILED_ATTEMPTS = 5;

export interface PairingOptions {
	connection: ChannelAcpConnection;
	relayUrl: string;
	webOrigin: string;
	staticKeyPair: KeyPair;
	linkTtlSeconds: number;
	coalesceMs: number;
	interactionTimeoutMs: number;
	relayToken?: string;
	logger?: ChannelLogger;
	/** Called once it has ended, for whatever reason. */
	onEnd?: (pairing: RelayPairing) => void;
}

export class RelayPairing implements ChannelAcpClient {
	private readonly options: PairingOptions;
	private readonly room = randomBytes(16);
	private psk: Uint8Array | undefined = randomBytes(32);
	private readonly expiry: number;
	private readonly link: string;
	private readonly seen = new EphemeralCache();
	private socket: WebSocket | undefined;
	private session: RelaySession | undefined;
	private proxy: AcpProxy | undefined;
	private status: ChannelPairing;
	private keyConfirmed = false;
	private failedAttempts = 0;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private keepalive: ReturnType<typeof setInterval> | undefined;

	constructor(options: PairingOptions) {
		this.options = options;
		this.expiry = Math.floor(Date.now() / 1000) + options.linkTtlSeconds;
		this.link = encodeLink({
			webOrigin: options.webOrigin,
			room: this.room,
			staticPublicKey: options.staticKeyPair.publicKey,
			psk: this.psk as Uint8Array,
			expiry: this.expiry,
		});
		this.status = {
			state: "waiting",
			link: this.link,
			expiresAt: new Date(this.expiry * 1000).toISOString(),
		};
	}

	/** Joins the relay as the room's agent. Resolves once the relay has answered. */
	async start(): Promise<void> {
		const base = this.options.relayUrl.replace(/\/+$/, "");
		const socket = new WebSocket(`${base}${roomPath(roomId(this.room))}`);

		socket.binaryType = "arraybuffer";
		this.socket = socket;
		this.deadline = setTimeout(
			() => this.end("The link expired before a browser paired."),
			this.options.linkTtlSeconds * 1000,
		);

		await new Promise<void>((resolve, reject) => {
			let answered = false;

			socket.addEventListener("open", () => {
				const hello: RelayHello = {
					v: 1,
					role: "agent",
					...(this.options.relayToken
						? { token: this.options.relayToken }
						: {}),
				};

				socket.send(JSON.stringify(hello));
			});
			socket.addEventListener("message", (event) => {
				if (!answered && typeof event.data === "string") {
					answered = true;
					resolve();
				}

				this.handleSocketMessage(event.data);
			});
			socket.addEventListener("close", () => {
				if (!answered) {
					answered = true;
					reject(
						new Error(`Could not reach the relay at ${this.options.relayUrl}.`),
					);
				}

				this.end(
					this.keyConfirmed
						? "The connection to the relay was lost."
						: "The relay closed the room.",
				);
			});
		});
	}

	pairing(): ChannelPairing {
		return { ...this.status };
	}

	async confirmPairing(accepted: boolean): Promise<void> {
		const session = this.session;

		if (this.status.state !== "verifying" || !session) {
			throw new Error("There are no words to confirm.");
		}

		if (!accepted) {
			session.close("The words were not confirmed.");
			return;
		}

		session.confirm();
		clearTimeout(this.deadline);
		this.proxy = new AcpProxy({
			connection: this.options.connection,
			send: (message) => session.send(message),
			coalesceMs: this.options.coalesceMs,
			interactionTimeoutMs: this.options.interactionTimeoutMs,
			...(this.options.logger ? { logger: this.options.logger } : {}),
		});
		this.status = { state: "connected", words: this.status.words };
	}

	notification(method: string, params: unknown): void {
		this.proxy?.notification(method, params);
	}

	async request(method: string, params: unknown): Promise<unknown> {
		// Nobody to ask until the browser is paired.
		return this.proxy
			? await this.proxy.request(method, params)
			: refusal(method, params, "reject");
	}

	/** The connection was dropped here (`kill`): tell the browser, leave the room, forget the link. */
	close(reason: string): void {
		this.finish(reason, false);
	}

	private handleSocketMessage(data: unknown): void {
		if (typeof data === "string") {
			this.handleStatus(data);
			return;
		}

		if (data instanceof ArrayBuffer) {
			this.session?.receive(new Uint8Array(data));
		}
	}

	private handleStatus(text: string): void {
		const status = parseRelayStatus(text);

		switch (status?.t) {
			case "ready":
				this.newSession();
				return;
			case "peer-left":
				this.peerLeft();
				return;
			case "closed":
				this.end(`The relay closed the room (${status.reason}).`);
				return;
			default:
				return;
		}
	}

	/** A browser has joined: a new handshake, with the link's psk, if it is still unspent. */
	private newSession(): void {
		const psk = this.psk;

		if (this.keyConfirmed || !psk || this.status.state === "ended") {
			return;
		}

		this.session?.transportClosed();
		const session = responder({
			staticKeyPair: this.options.staticKeyPair,
			psk,
			room: this.room,
			webOrigin: this.options.webOrigin,
			acceptEphemeral: this.seen.accept,
			send: (data) => this.socket?.send(data),
			onKeyConfirmed: () => {
				// The psk is spent: no other browser can pair with this link.
				this.keyConfirmed = true;
				this.psk = undefined;
				clearTimeout(this.deadline);
				this.deadline = setTimeout(
					() => this.end("The words were not confirmed in time."),
					Math.max(this.expiry * 1000 - Date.now(), VERIFY_GRACE_MS),
				);
				this.keepalive = setInterval(() => {
					if (session.state === "pairing" || session.state === "open") {
						session.ping();
					}
				}, KEEPALIVE_MS);
			},
			onHandshake: (info) => {
				this.status = { state: "verifying", words: info.sas };
			},
			onMessage: (message) => {
				void this.proxy?.receive(message);
			},
			onClose: (event) => this.sessionClosed(session, event),
		});

		this.session = session;
	}

	private peerLeft(): void {
		const session = this.session;

		session?.transportClosed("The browser left.");

		if (!this.keyConfirmed) {
			// A browser that never proved it had the link: wait for another.
			this.session = undefined;
		}
	}

	private sessionClosed(session: RelaySession, event: CloseEvent): void {
		if (session !== this.session) {
			return;
		}

		if (!this.keyConfirmed) {
			// Before key confirmation nothing is spent: a bad or replayed
			// handshake ends that attempt, not the link.
			this.session = undefined;

			if (event.kind === "error") {
				this.failedAttempts++;
				this.options.logger?.warn("A browser failed to pair.", {
					reason: event.reason,
				});

				if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
					this.end("Too many failed attempts to pair; the link is spent.");
				}
			}
			return;
		}

		switch (event.kind) {
			case "ended":
				this.end(
					event.byPeer
						? `The browser ended the session${event.reason ? `: ${event.reason}` : "."}`
						: event.reason,
				);
				return;
			case "lost":
				this.end(`The connection to the browser was lost: ${event.reason}`);
				return;
			case "error":
				this.end(`The browser broke the protocol: ${event.reason}`);
				return;
		}
	}

	/** It ended here or at the browser: drop the connection too. */
	private end(reason: string): void {
		if (this.finish(reason, true)) {
			void this.options.connection.end(reason);
		}
	}

	/** Returns false if it had already ended. */
	private finish(reason: string, fromRemote: boolean): boolean {
		if (this.status.state === "ended") {
			return false;
		}

		this.status = { state: "ended", reason };
		this.psk = undefined;
		clearTimeout(this.deadline);
		clearInterval(this.keepalive);
		this.proxy?.close();

		const session = this.session;

		if (session && session.state !== "closed") {
			if (session.state === "pairing" || session.state === "open") {
				session.close(
					fromRemote ? reason : "Disconnected on the agent's machine.",
				);
			} else {
				session.transportClosed();
			}
		}

		try {
			this.socket?.close(1000);
		} catch {
			// Already closed.
		}

		this.options.onEnd?.(this);
		return true;
	}
}
