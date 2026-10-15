/**
 * One end of an encrypted channel over a relay: the Noise handshake, then
 * framed ACP messages. Both sides use it — the browser as the
 * {@link initiator}, the agent side as the {@link responder}.
 *
 * The session does no I/O of its own. Give it `send`, which puts one binary
 * message on the relay socket, and hand every binary message from the socket
 * to `receive`. When the socket ends, call `transportClosed`.
 */

import { equalBytes, utf8Decode, utf8Encode } from "./bytes.ts";
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
	HandshakeState,
	type KeyPair,
	MAX_MESSAGE_LENGTH,
	NoiseError,
} from "./noise.ts";
import { sasWords } from "./sas.ts";

/** Each side rekeys its sending CipherState after this many messages, and its receiving one likewise. */
export const REKEY_INTERVAL = 10_000;

export type SessionState =
	/** The initiator has not called `start` yet. */
	| "idle"
	/** The handshake is under way. */
	| "handshake"
	/**
	 * Keys confirmed (the initiator's first frame, a PING, has decrypted);
	 * waiting for the user to confirm the SAS words on the agent side.
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
	 * link's psk used up.
	 */
	onKeyConfirmed?: () => void;
	/** Initiator only: the agent side sent CONFIRMED; `send` may now be used. */
	onConfirmed?: () => void;
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
}

export interface InitiatorOptions extends SessionOptions {
	/** The parsed pairing link. Check its expiry first. */
	link: PairingLink;
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

/** One end of the channel. Use {@link initiator} or {@link responder} to make one. */
export class RelaySession implements SessionHandlers {
	readonly role: "initiator" | "responder";
	onHandshake: SessionHandlers["onHandshake"];
	onKeyConfirmed: SessionHandlers["onKeyConfirmed"];
	onConfirmed: SessionHandlers["onConfirmed"];
	onMessage: SessionHandlers["onMessage"];
	onPong: SessionHandlers["onPong"];
	onClose: SessionHandlers["onClose"];

	private stateValue: SessionState;
	private readonly handshake: HandshakeState;
	private readonly sendRaw: (data: Uint8Array) => void;
	private readonly acceptEphemeral:
		| ((ephemeralPublicKey: Uint8Array) => boolean)
		| undefined;
	private readonly reassembler: Reassembler;
	private sendCipher: CipherState | undefined;
	private receiveCipher: CipherState | undefined;
	private nextStream = 1;
	private keyConfirmed = false;
	private info: HandshakeInfo | undefined;

	constructor(
		role: "initiator" | "responder",
		handshake: HandshakeState,
		options: SessionOptions & {
			acceptEphemeral?: ResponderOptions["acceptEphemeral"];
		},
	) {
		this.role = role;
		this.handshake = handshake;
		this.sendRaw = options.send;
		this.acceptEphemeral = options.acceptEphemeral;
		this.reassembler = new Reassembler(
			options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
		);
		this.stateValue = role === "initiator" ? "idle" : "handshake";
		this.onHandshake = options.onHandshake;
		this.onKeyConfirmed = options.onKeyConfirmed;
		this.onConfirmed = options.onConfirmed;
		this.onMessage = options.onMessage;
		this.onPong = options.onPong;
		this.onClose = options.onClose;
	}

	get state(): SessionState {
		return this.stateValue;
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
		this.sendRaw(this.handshake.writeMessage(EMPTY));
	}

	/**
	 * Responder: the user confirmed the SAS words. Sends CONFIRMED, and lets
	 * ACP messages through from now on.
	 */
	confirm(): void {
		if (this.role !== "responder" || this.stateValue !== "pairing") {
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
		const stream = this.nextStream++;
		for (const frame of chunkMessage(stream, utf8Encode(message))) {
			this.sendFrame(frame);
		}
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
		try {
			this.receiveUnsafe(data);
		} catch (error) {
			if (
				error instanceof NoiseError ||
				error instanceof FrameError ||
				error instanceof SessionError
			) {
				this.fail(error);
				return;
			}
			throw error;
		}
	}

	private receiveUnsafe(data: Uint8Array): void {
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
				} else {
					this.receiveHandshake(data);
				}
				return;
			default:
				this.receiveTransport(data);
		}
	}

	private receiveHandshake(data: Uint8Array): void {
		const payload = this.handshake.readMessage(data);
		if (payload.length > 0) {
			throw new SessionError("Handshake payloads are empty");
		}
		let reply: Uint8Array | undefined;
		if (this.role === "responder") {
			const ephemeral = data.slice(0, 32);
			if (this.acceptEphemeral && !this.acceptEphemeral(ephemeral)) {
				throw new SessionError("Replayed handshake message");
			}
			reply = this.handshake.writeMessage(EMPTY);
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
		// the keys before it shows the words.
		this.sendFrame(controlFrame(FrameType.PING));
		if (this.stateValue === "pairing") {
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
				const message = this.reassembler.push(frame);
				if (message) {
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
				this.stateValue = "open";
				this.onConfirmed?.();
				return;
		}
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
	return new RelaySession("initiator", handshake, options);
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
	return new RelaySession("responder", handshake, options);
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
