/**
 * One end of an encrypted channel over a relay: the Noise handshake, then
 * framed ACP messages. Both sides use it — the browser as the
 * {@link initiator}, the agent side as the {@link responder} — to pair with
 * a link, and a remembered browser and the agent side to reconnect
 * ({@link reconnectInitiator}, {@link reconnectResponder}).
 *
 * The session does no I/O of its own. Give it `send`, which puts one binary
 * message on the relay socket, and hand every binary message from the socket
 * to `receive`. When the socket ends, call `transportClosed`.
 */

import {
	base64urlDecode,
	base64urlEncode,
	equalBytes,
	utf8Decode,
	utf8Encode,
} from "./bytes.ts";
import {
	chunkMessage,
	controlFrame,
	DEFAULT_MAX_MESSAGE_BYTES,
	decodeFrame,
	encodeFrame,
	type Frame,
	FrameError,
	FrameType,
	Reassembler,
} from "./frames.ts";
import { type PairingLink, prologue } from "./link.ts";
import {
	type CipherState,
	DHLEN,
	type HandshakeResult,
	HandshakeState,
	type KeyPair,
	KKHandshakeState,
	MAX_MESSAGE_LENGTH,
	NoiseError,
	type StaticKey,
	staticKey,
} from "./noise.ts";
import { sasWords } from "./sas.ts";

/** Each side rekeys its sending CipherState after this many messages, and its receiving one likewise. */
export const REKEY_INTERVAL = 10_000;
/** How much of what it sent each side keeps by default, to resend after a reconnect. */
export const DEFAULT_RESUME_BYTES = 8 * 1024 * 1024;

/**
 * What one side keeps across the transports of a connection, so a reconnect
 * loses nothing: ACP stream ids go on counting from one transport to the
 * next, and the messages most recently sent are kept to send again.
 */
export class ResumeBuffer {
	/** The last stream received whole from the other side. */
	received = 0;
	private next = 1;
	private kept: { stream: number; message: string }[] = [];
	private keptBytes = 0;

	constructor(private readonly maxBytes = DEFAULT_RESUME_BYTES) {}

	/** The stream id of the next message sent. */
	get nextStream(): number {
		return this.next;
	}

	/** Numbers a message to send and keeps it, dropping the oldest past the limit. */
	add(message: string): number {
		const stream = this.next++;
		this.kept.push({ stream, message });
		this.keptBytes += message.length;
		while (this.keptBytes > this.maxBytes && this.kept.length > 0) {
			this.keptBytes -= (
				this.kept.shift() as { message: string }
			).message.length;
		}
		return stream;
	}

	/**
	 * The messages sent after stream `stream`, which the other side says it
	 * received last; undefined if some are no longer kept (or never were).
	 */
	after(stream: number): { stream: number; message: string }[] | undefined {
		if (!Number.isInteger(stream) || stream < 0 || stream >= this.next) {
			return undefined;
		}
		if (stream === this.next - 1) {
			return [];
		}
		const first = this.kept[0];
		if (!first || first.stream > stream + 1) {
			return undefined;
		}
		return this.kept.filter((entry) => entry.stream > stream);
	}

	/** Starts again from stream 1 both ways: nothing before is resent. */
	reset(): void {
		this.received = 0;
		this.next = 1;
		this.kept = [];
		this.keptBytes = 0;
	}
}

export type SessionState =
	/** The initiator has not called `start` yet. */
	| "idle"
	/** The handshake is under way. */
	| "handshake"
	/**
	 * Keys confirmed (the initiator's first frame, a PING, has decrypted);
	 * waiting for the user to confirm the SAS words on the agent side, or,
	 * reconnecting, for the agent side's CONFIRMED.
	 */
	| "pairing"
	/** Confirmed: ACP messages flow both ways. */
	| "open"
	| "closed";

export interface HandshakeInfo {
	/** The four SAS words both sides show. */
	sas: string[];
	/** The final handshake hash `h`. */
	handshakeHash: Uint8Array;
}

export type CloseEvent =
	/** An authenticated CLOSE was sent or received: the session ended on purpose. */
	| { kind: "ended"; reason: string; byPeer: boolean }
	/** The socket ended without an authenticated CLOSE. Report it as "connection lost". */
	| { kind: "lost"; reason: string }
	/** A rule was broken or a message failed to decrypt. The socket must be closed. */
	| { kind: "error"; reason: string; error: Error };

export interface SessionHandlers {
	/**
	 * Show `sas` to the user. The initiator calls it when the handshake
	 * finishes, the responder only once the keys are confirmed.
	 */
	onHandshake?: (info: HandshakeInfo) => void;
	/**
	 * Responder only: the first transport message from the initiator decrypted,
	 * so the peer really holds the keys (key confirmation). Only now is the
	 * link's psk used up. Reconnecting, the session is already open by then:
	 * there are no words, so the responder sends CONFIRMED by itself.
	 */
	onKeyConfirmed?: () => void;
	/** Initiator only: the agent side sent CONFIRMED; `send` may now be used. */
	onConfirmed?: () => void;
	/**
	 * Responder only, after a pairing: the browser sent its static public key
	 * (REMEMBER), to reconnect with later.
	 */
	onRemember?: (publicKey: Uint8Array) => void;
	/** One whole ACP message (a JSON-RPC 2.0 message, as text). */
	onMessage?: (message: string) => void;
	/** A PONG answered a PING. */
	onPong?: (payload: Uint8Array) => void;
	/** The session is over, for one of the reasons in {@link CloseEvent}. */
	onClose?: (event: CloseEvent) => void;
}

export interface SessionOptions extends SessionHandlers {
	/** Puts one binary message on the relay socket. */
	send: (data: Uint8Array) => void;
	/** The largest ACP message accepted from the peer. Defaults to 32 MiB. */
	maxMessageBytes?: number;
	/** Fixes the ephemeral key, for tests only. */
	ephemeralPrivateKey?: Uint8Array;
	/**
	 * Kept across the transports of one connection: give a reconnect the
	 * buffer the connection's earlier sessions used. A new one by default.
	 */
	buffer?: ResumeBuffer;
}

export interface InitiatorOptions extends SessionOptions {
	/** The parsed pairing link. Check its expiry first. */
	link: PairingLink;
}

export interface ReconnectInitiatorOptions extends SessionOptions {
	room: Uint8Array;
	webOrigin: string;
	/** The agent side's static key, from the link the browser paired with. */
	remoteStaticPublicKey: Uint8Array;
	/** The browser's own static key, whose public half it sent in REMEMBER. */
	staticKey: StaticKey;
	/**
	 * Ask to carry on where the last transport stopped, with `buffer`'s
	 * streams. False for a page that has lost them (a reload): both sides
	 * start again from stream 1, and the browser loads the session afresh.
	 */
	resume: boolean;
}

export interface ReconnectResponderOptions extends SessionOptions {
	staticKeyPair: KeyPair;
	room: Uint8Array;
	webOrigin: string;
	/** The browser's static key, from its REMEMBER. */
	remoteStaticPublicKey: Uint8Array;
}

export interface ResponderOptions extends SessionOptions {
	staticKeyPair: KeyPair;
	psk: Uint8Array;
	room: Uint8Array;
	webOrigin: string;
	/**
	 * Called with the initiator's ephemeral key once message 1 has decrypted.
	 * Return false if it has been seen before while the link is valid: the
	 * message is a replay, and the session fails.
	 */
	acceptEphemeral?: (ephemeralPublicKey: Uint8Array) => boolean;
}

export class SessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}

const EMPTY = new Uint8Array(0);

/** Either handshake: NKpsk0 steps are synchronous, KK steps asynchronous. */
interface Handshake {
	writeMessage(payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
	readMessage(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
	readonly result: HandshakeResult | undefined;
}

/** Calls `next` with `value` now if it is ready, else once it resolves. */
function then<T>(
	value: T | Promise<T>,
	next: (value: T) => void | Promise<void>,
): void | Promise<void> {
	return value instanceof Promise ? value.then(next) : next(value);
}

/** One end of the channel. Use {@link initiator} or {@link responder} to make one. */
export class RelaySession implements SessionHandlers {
	readonly role: "initiator" | "responder";
	/** A first pairing with a link, or a remembered browser coming back. */
	readonly kind: "pairing" | "reconnect";
	/** What this side keeps across the connection's transports. */
	readonly buffer: ResumeBuffer;
	onHandshake: SessionHandlers["onHandshake"];
	onKeyConfirmed: SessionHandlers["onKeyConfirmed"];
	onConfirmed: SessionHandlers["onConfirmed"];
	onMessage: SessionHandlers["onMessage"];
	onPong: SessionHandlers["onPong"];
	onRemember: SessionHandlers["onRemember"];
	onClose: SessionHandlers["onClose"];

	private stateValue: SessionState;
	private readonly handshake: Handshake;
	private readonly sendRaw: (data: Uint8Array) => void;
	private readonly acceptEphemeral:
		| ((ephemeralPublicKey: Uint8Array) => boolean)
		| undefined;
	private reassembler: Reassembler;
	private readonly maxMessageBytes: number;
	private readonly askResume: boolean;
	private sendCipher: CipherState | undefined;
	private receiveCipher: CipherState | undefined;
	private keyConfirmed = false;
	private resumedValue = false;
	private info: HandshakeInfo | undefined;
	/** REMEMBER has been sent or received. */
	private remembered = false;
	/** An ACP message has gone, or come, since CONFIRMED: too late for REMEMBER. */
	private acpSeen = false;
	/** A handshake step is waiting on an asynchronous DH. */
	private busy = false;
	/** What arrived meanwhile, in order. */
	private readonly backlog: Uint8Array[] = [];

	constructor(
		role: "initiator" | "responder",
		kind: "pairing" | "reconnect",
		handshake: Handshake,
		options: SessionOptions & {
			acceptEphemeral?: ResponderOptions["acceptEphemeral"];
			resume?: boolean;
		},
	) {
		this.role = role;
		this.kind = kind;
		this.buffer = options.buffer ?? new ResumeBuffer();
		this.askResume = options.resume ?? false;
		if (kind === "pairing" || (role === "initiator" && !this.askResume)) {
			this.buffer.reset();
		}
		this.handshake = handshake;
		this.sendRaw = options.send;
		this.acceptEphemeral = options.acceptEphemeral;
		this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		this.reassembler = new Reassembler(
			this.maxMessageBytes,
			this.buffer.received,
		);
		this.stateValue = role === "initiator" ? "idle" : "handshake";
		this.onHandshake = options.onHandshake;
		this.onKeyConfirmed = options.onKeyConfirmed;
		this.onConfirmed = options.onConfirmed;
		this.onMessage = options.onMessage;
		this.onPong = options.onPong;
		this.onRemember = options.onRemember;
		this.onClose = options.onClose;
	}

	get state(): SessionState {
		return this.stateValue;
	}

	/**
	 * A reconnect that carried on from the last transport: nothing was lost.
	 * False after a pairing, or a reconnect that started again from stream 1,
	 * when the browser must load the session afresh. Set before
	 * `onConfirmed` and `onKeyConfirmed` run.
	 */
	get resumed(): boolean {
		return this.resumedValue;
	}

	/** The SAS words and handshake hash, once the handshake is done (and, on the agent side, the keys confirmed). */
	get handshakeInfo(): HandshakeInfo | undefined {
		return this.stateValue === "handshake" ? undefined : this.info;
	}

	/** Initiator: sends message 1. */
	start(): void {
		if (this.role !== "initiator" || this.stateValue !== "idle") {
			throw new SessionError("Only an idle initiator can start");
		}
		this.stateValue = "handshake";
		this.run(() =>
			then(this.handshake.writeMessage(EMPTY), (message) => {
				if (this.stateValue === "handshake") {
					this.sendRaw(message);
				}
			}),
		);
	}

	/**
	 * Responder: the user confirmed the SAS words. Sends CONFIRMED, and lets
	 * ACP messages through from now on.
	 */
	confirm(): void {
		if (
			this.role !== "responder" ||
			this.kind !== "pairing" ||
			this.stateValue !== "pairing"
		) {
			throw new SessionError("Only a responder that is pairing can confirm");
		}
		this.sendFrame(controlFrame(FrameType.CONFIRMED));
		this.stateValue = "open";
	}

	/** Sends one ACP message (a JSON-RPC 2.0 message, as text). */
	send(message: string): void {
		if (this.stateValue !== "open") {
			throw new SessionError(`Cannot send while ${this.stateValue}`);
		}
		this.acpSeen = true;
		this.sendStream(this.buffer.add(message), message);
	}

	private sendStream(stream: number, message: string): void {
		for (const frame of chunkMessage(stream, utf8Encode(message))) {
			this.sendFrame(frame);
		}
	}

	/**
	 * Initiator, after a pairing: sends REMEMBER with the public half of the
	 * static key it will reconnect with. Once, as soon as CONFIRMED has come,
	 * before any ACP message.
	 */
	remember(publicKey: Uint8Array): void {
		if (
			this.role !== "initiator" ||
			this.kind !== "pairing" ||
			this.stateValue !== "open" ||
			this.remembered ||
			this.acpSeen
		) {
			throw new SessionError(
				"REMEMBER goes once, right after CONFIRMED of a pairing",
			);
		}
		if (publicKey.length !== DHLEN) {
			throw new SessionError("A static key is 32 bytes");
		}
		this.remembered = true;
		this.sendFrame(
			controlFrame(FrameType.REMEMBER, utf8Encode(base64urlEncode(publicKey))),
		);
	}

	ping(payload: Uint8Array = EMPTY): void {
		if (this.stateValue !== "pairing" && this.stateValue !== "open") {
			throw new SessionError(`Cannot ping while ${this.stateValue}`);
		}
		this.sendFrame(controlFrame(FrameType.PING, payload));
	}

	/** Ends the session with an authenticated CLOSE. */
	close(reason = ""): void {
		if (this.stateValue === "closed") {
			return;
		}
		if (this.sendCipher) {
			this.sendFrame(controlFrame(FrameType.CLOSE, utf8Encode(reason)));
		}
		this.finish({ kind: "ended", reason, byPeer: false });
	}

	/** The socket ended. Without an authenticated CLOSE first, the connection was lost. */
	transportClosed(reason = "connection lost"): void {
		if (this.stateValue !== "closed") {
			this.finish({ kind: "lost", reason });
		}
	}

	/** Takes one binary message from the relay socket. */
	receive(data: Uint8Array): void {
		if (this.stateValue === "closed") {
			return;
		}
		if (this.busy) {
			this.backlog.push(data);
			return;
		}
		this.run(() => this.receiveUnsafe(data));
	}

	/**
	 * Runs one step. A step that waits on a DH holds back what arrives
	 * meanwhile, which then runs in order.
	 */
	private run(step: () => void | Promise<void>): void {
		let pending: void | Promise<void>;
		try {
			pending = step();
		} catch (error) {
			this.failOn(error, true);
			return;
		}
		if (!pending) {
			return;
		}
		this.busy = true;
		pending.then(
			() => this.resume(),
			(error: unknown) => {
				this.failOn(error, false);
				this.resume();
			},
		);
	}

	private resume(): void {
		this.busy = false;
		while (!this.busy && this.backlog.length > 0) {
			const next = this.backlog.shift() as Uint8Array;
			this.receive(next);
		}
	}

	/** Protocol errors end the session; others are bugs, thrown when they can be. */
	private failOn(error: unknown, rethrow: boolean): void {
		if (
			error instanceof NoiseError ||
			error instanceof FrameError ||
			error instanceof SessionError ||
			!rethrow
		) {
			if (this.stateValue !== "closed") {
				this.fail(
					error instanceof Error ? error : new SessionError(String(error)),
				);
			}
			return;
		}
		throw error;
	}

	private receiveUnsafe(data: Uint8Array): void | Promise<void> {
		if (data.length > MAX_MESSAGE_LENGTH) {
			throw new SessionError("Message longer than a Noise message");
		}
		switch (this.stateValue) {
			case "idle":
				throw new SessionError("Message before the handshake started");
			case "handshake":
				if (this.receiveCipher) {
					// Responder: message 2 is out; this is the browser's first frame.
					this.receiveTransport(data);
					return;
				}
				return this.receiveHandshake(data);
			default:
				this.receiveTransport(data);
		}
	}

	private receiveHandshake(data: Uint8Array): void | Promise<void> {
		return then(this.handshake.readMessage(data), (payload) => {
			if (payload.length > 0) {
				throw new SessionError("Handshake payloads are empty");
			}
			if (this.role !== "responder") {
				return this.handshakeDone(undefined);
			}
			const ephemeral = data.slice(0, 32);
			if (this.acceptEphemeral && !this.acceptEphemeral(ephemeral)) {
				throw new SessionError("Replayed handshake message");
			}
			return then(this.handshake.writeMessage(EMPTY), (reply) =>
				this.handshakeDone(reply),
			);
		});
	}

	/** Message 2 is written (responder, `reply`) or read (initiator). */
	private handshakeDone(reply: Uint8Array | undefined): void {
		if (this.stateValue !== "handshake") {
			return;
		}
		const result = this.handshake.result;
		if (!result) {
			throw new SessionError("Handshake did not finish");
		}
		// Keys first: the peer may answer before `send` returns.
		this.sendCipher = result.send;
		this.receiveCipher = result.receive;
		this.info = {
			sas: sasWords(result.handshakeHash),
			handshakeHash: result.handshakeHash,
		};
		if (reply) {
			// The words wait for key confirmation: a replayed message 1 must not
			// put them in front of the user.
			this.sendRaw(reply);
			return;
		}
		this.stateValue = "pairing";
		// The first transport frame is a PING, so the agent side can confirm
		// the keys before it shows the words. Reconnecting, it carries the
		// last stream received, to carry on from.
		this.sendFrame(
			controlFrame(
				FrameType.PING,
				this.askResume ? u32(this.buffer.received) : EMPTY,
			),
		);
		if (this.stateValue === "pairing" && this.kind === "pairing") {
			this.onHandshake?.(this.info);
		}
	}

	private receiveTransport(data: Uint8Array): void {
		const cipher = this.receiveCipher as CipherState;
		const plaintext = cipher.decryptWithAd(EMPTY, data);
		if (cipher.messages % REKEY_INTERVAL === 0) {
			cipher.rekey();
		}
		const frame = decodeFrame(plaintext);
		if (this.role === "responder" && !this.keyConfirmed) {
			if (frame.type !== FrameType.PING) {
				throw new SessionError("The first frame from the browser is a PING");
			}
			this.keyConfirmed = true;
			if (this.kind === "reconnect") {
				// Both static keys are known: no words to confirm.
				this.openReconnect(frame.payload);
				if (this.stateValue === "open") {
					this.onKeyConfirmed?.();
				}
				if (this.stateValue === "open") {
					this.handleFrame(frame);
				}
				return;
			}
			this.stateValue = "pairing";
			this.onKeyConfirmed?.();
			if (this.stateValue !== "pairing") {
				return;
			}
			this.onHandshake?.(this.info as HandshakeInfo);
			if (this.stateValue !== "pairing") {
				return;
			}
		}
		this.handleFrame(frame);
	}

	private handleFrame(frame: Frame): void {
		switch (frame.type) {
			case FrameType.ACP: {
				if (this.stateValue !== "open") {
					throw new SessionError("ACP message before the SAS was confirmed");
				}
				this.acpSeen = true;
				const message = this.reassembler.push(frame);
				if (message) {
					this.buffer.received = frame.stream;
					this.onMessage?.(decodeText(message));
				}
				return;
			}
			case FrameType.CLOSE:
				this.reassembler.end();
				this.finish({
					kind: "ended",
					reason: decodeText(frame.payload),
					byPeer: true,
				});
				return;
			case FrameType.PING:
				this.sendFrame(controlFrame(FrameType.PONG, frame.payload));
				return;
			case FrameType.PONG:
				this.onPong?.(frame.payload);
				return;
			case FrameType.CONFIRMED:
				if (this.role !== "initiator" || this.stateValue !== "pairing") {
					throw new SessionError("Unexpected CONFIRMED");
				}
				if (this.kind === "reconnect") {
					this.confirmReconnect(frame.payload);
				} else if (frame.payload.length > 0) {
					throw new SessionError("CONFIRMED of a pairing is empty");
				} else {
					this.stateValue = "open";
				}
				this.onConfirmed?.();
				return;
			case FrameType.REMEMBER: {
				if (
					this.role !== "responder" ||
					this.kind !== "pairing" ||
					this.stateValue !== "open" ||
					this.remembered ||
					this.acpSeen
				) {
					throw new SessionError("Unexpected REMEMBER");
				}
				let key: Uint8Array;
				try {
					key = base64urlDecode(decodeText(frame.payload));
				} catch {
					throw new FrameError("REMEMBER carries a 32-byte key in base64url");
				}
				if (key.length !== DHLEN) {
					throw new FrameError("REMEMBER carries a 32-byte key in base64url");
				}
				this.remembered = true;
				this.onRemember?.(key);
				return;
			}
		}
	}

	/**
	 * Responder, reconnecting: the browser's first PING has decrypted. Its
	 * payload, if any, is the last stream it received. Answers CONFIRMED with
	 * the last stream received here, then sends again what the browser
	 * missed; or, if that can't be done, an empty CONFIRMED, and both sides
	 * start again from stream 1.
	 */
	private openReconnect(payload: Uint8Array): void {
		if (payload.length !== 0 && payload.length !== 4) {
			throw new SessionError("A reconnect's PING is empty, or a u32");
		}
		const missed =
			payload.length === 4 ? this.buffer.after(readU32(payload)) : undefined;
		if (!missed) {
			this.restart();
			this.sendFrame(controlFrame(FrameType.CONFIRMED));
			this.stateValue = "open";
			return;
		}
		this.sendFrame(
			controlFrame(FrameType.CONFIRMED, u32(this.buffer.received)),
		);
		this.resumedValue = true;
		this.stateValue = "open";
		for (const { stream, message } of missed) {
			this.sendStream(stream, message);
		}
	}

	/** Initiator, reconnecting: the agent side's CONFIRMED. */
	private confirmReconnect(payload: Uint8Array): void {
		if (payload.length === 0) {
			this.restart();
			this.stateValue = "open";
			return;
		}
		if (!this.askResume) {
			throw new SessionError("CONFIRMED resumes what was not asked for");
		}
		const missed = this.buffer.after(readU32(payload));
		if (!missed) {
			throw new SessionError(
				"Cannot resume: messages the agent side missed are gone",
			);
		}
		this.resumedValue = true;
		this.stateValue = "open";
		for (const { stream, message } of missed) {
			this.sendStream(stream, message);
		}
	}

	private restart(): void {
		this.buffer.reset();
		this.reassembler = new Reassembler(this.maxMessageBytes, 0);
	}

	private sendFrame(frame: Frame): void {
		const cipher = this.sendCipher;
		if (!cipher) {
			throw new SessionError("No transport keys yet");
		}
		const ciphertext = cipher.encryptWithAd(EMPTY, encodeFrame(frame));
		if (cipher.messages % REKEY_INTERVAL === 0) {
			cipher.rekey();
		}
		this.sendRaw(ciphertext);
	}

	private fail(error: Error): void {
		this.finish({ kind: "error", reason: error.message, error });
	}

	private finish(event: CloseEvent): void {
		this.stateValue = "closed";
		this.sendCipher = undefined;
		this.receiveCipher = undefined;
		this.onClose?.(event);
	}
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value);
	return out;
}

function readU32(bytes: Uint8Array): number {
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
}

function decodeText(bytes: Uint8Array): string {
	try {
		return utf8Decode(bytes);
	} catch {
		throw new FrameError("Invalid UTF-8");
	}
}

/**
 * The browser's end: no static key, the agent side's key and the psk from
 * the link. Call `start` once the relay says `ready`.
 */
export function initiator(options: InitiatorOptions): RelaySession {
	const handshake = HandshakeState.initiator({
		prologue: prologue(options.link.room, options.link.webOrigin),
		psk: options.link.psk,
		remoteStaticPublicKey: options.link.staticPublicKey,
		ephemeralPrivateKey: options.ephemeralPrivateKey,
	});
	return new RelaySession("initiator", "pairing", handshake, options);
}

/**
 * The agent side's end, with its static key and the link's psk. It answers
 * message 1 when it arrives.
 */
export function responder(options: ResponderOptions): RelaySession {
	const handshake = HandshakeState.responder({
		prologue: prologue(options.room, options.webOrigin),
		psk: options.psk,
		staticKeyPair: options.staticKeyPair,
		ephemeralPrivateKey: options.ephemeralPrivateKey,
	});
	return new RelaySession("responder", "pairing", handshake, options);
}

/**
 * A remembered browser's end of a reconnect (Noise KK): its own static key,
 * and the agent side's from the link it paired with. Call `start` once the
 * relay says `ready`.
 */
export function reconnectInitiator(
	options: ReconnectInitiatorOptions,
): RelaySession {
	const handshake = KKHandshakeState.initiator({
		prologue: prologue(options.room, options.webOrigin),
		staticKey: options.staticKey,
		remoteStaticPublicKey: options.remoteStaticPublicKey,
		ephemeralPrivateKey: options.ephemeralPrivateKey,
	});
	return new RelaySession("initiator", "reconnect", handshake, options);
}

/**
 * The agent side's end of a reconnect, with the key the browser sent in
 * REMEMBER. It answers message 1 when it arrives, and opens by itself once
 * the keys are confirmed.
 */
export function reconnectResponder(
	options: ReconnectResponderOptions,
): RelaySession {
	const handshake = KKHandshakeState.responder({
		prologue: prologue(options.room, options.webOrigin),
		staticKey: staticKey(options.staticKeyPair),
		remoteStaticPublicKey: options.remoteStaticPublicKey,
		ephemeralPrivateKey: options.ephemeralPrivateKey,
	});
	return new RelaySession("responder", "reconnect", handshake, options);
}

/** Remembers the ephemeral keys seen while a link is valid, to refuse replays of message 1. */
export class EphemeralCache {
	private readonly seen: Uint8Array[] = [];

	/** Returns false if `key` was seen before; otherwise remembers it. */
	accept = (key: Uint8Array): boolean => {
		if (this.seen.some((seen) => equalBytes(seen, key))) {
			return false;
		}
		this.seen.push(key.slice());
		return true;
	};
}
