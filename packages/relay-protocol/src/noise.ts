/**
 * `Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s`, following the Noise Protocol
 * Framework, revision 34 (https://noiseprotocol.org/noise.html): the
 * CipherState, SymmetricState and HandshakeState objects of §5, with the
 * `psk` modifier of §9 and `Rekey()` of §11.3.
 *
 * NKpsk0:
 *
 *     <- s
 *     ...
 *     -> psk, e, es
 *     <- e, ee
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { concatBytes, randomBytes, utf8Encode } from "./bytes.ts";

export const PROTOCOL_NAME = "Noise_NKpsk0_25519_ChaChaPoly_BLAKE2s";
export const DHLEN = 32;
export const HASHLEN = 32;
export const KEYLEN = 32;
export const TAGLEN = 16;
/** The largest Noise message, in bytes (§3). */
export const MAX_MESSAGE_LENGTH = 65535;

/** A decryption failed, or a message could not be processed. Always fatal. */
export class NoiseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoiseError";
	}
}

export interface KeyPair {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
}

/** Makes an X25519 key pair, from `privateKey` if given. */
export function generateKeyPair(privateKey?: Uint8Array): KeyPair {
	const secret = privateKey ?? randomBytes(DHLEN);
	if (secret.length !== DHLEN) {
		throw new NoiseError("An X25519 private key is 32 bytes");
	}
	return { privateKey: secret, publicKey: x25519.getPublicKey(secret) };
}

function dh(keyPair: KeyPair, publicKey: Uint8Array): Uint8Array {
	try {
		return x25519.getSharedSecret(keyPair.privateKey, publicKey);
	} catch {
		// A low-order public key gives an all-zero result, which noble refuses.
		throw new NoiseError("Invalid X25519 public key");
	}
}

function hash(data: Uint8Array): Uint8Array {
	return blake2s(data);
}

/** HKDF from §4.3, with HMAC-BLAKE2s. */
function hkdf(
	chainingKey: Uint8Array,
	inputKeyMaterial: Uint8Array,
	outputs: 2 | 3,
): Uint8Array[] {
	const tempKey = hmac(blake2s, chainingKey, inputKeyMaterial);
	const output1 = hmac(blake2s, tempKey, Uint8Array.of(1));
	const output2 = hmac(
		blake2s,
		tempKey,
		concatBytes(output1, Uint8Array.of(2)),
	);
	if (outputs === 2) {
		return [output1, output2];
	}
	const output3 = hmac(
		blake2s,
		tempKey,
		concatBytes(output2, Uint8Array.of(3)),
	);
	return [output1, output2, output3];
}

/** ChaChaPoly's nonce: 32 bits of zeros, then the 64-bit counter, little-endian. */
function chachaNonce(n: number): Uint8Array {
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setUint32(4, n >>> 0, true);
	view.setUint32(8, Math.floor(n / 2 ** 32), true);
	return nonce;
}

/** 2^64 − 1, the nonce `Rekey()` uses and no message may. */
const REKEY_NONCE = Uint8Array.of(
	0,
	0,
	0,
	0,
	255,
	255,
	255,
	255,
	255,
	255,
	255,
	255,
);

/**
 * A key and a nonce counter (§5.1). The counter is a JavaScript number, so it
 * stops at 2^53 rather than 2^64 − 1; a session never gets near either.
 */
export class CipherState {
	private key: Uint8Array | undefined;
	private nonce = 0;

	constructor(key?: Uint8Array) {
		if (key) {
			this.initializeKey(key);
		}
	}

	initializeKey(key: Uint8Array): void {
		this.key = key;
		this.nonce = 0;
	}

	hasKey(): boolean {
		return this.key !== undefined;
	}

	/** How many messages this state has encrypted or decrypted. */
	get messages(): number {
		return this.nonce;
	}

	encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
		if (!this.key) {
			return plaintext;
		}
		this.checkNonce();
		const ciphertext = chacha20poly1305(
			this.key,
			chachaNonce(this.nonce),
			ad,
		).encrypt(plaintext);
		this.nonce++;
		return ciphertext;
	}

	/** Throws a {@link NoiseError} if the tag does not verify; the nonce is then unchanged. */
	decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
		if (!this.key) {
			return ciphertext;
		}
		this.checkNonce();
		let plaintext: Uint8Array;
		try {
			plaintext = chacha20poly1305(
				this.key,
				chachaNonce(this.nonce),
				ad,
			).decrypt(ciphertext);
		} catch {
			throw new NoiseError("Decryption failed");
		}
		this.nonce++;
		return plaintext;
	}

	/** §11.3: replaces the key with the first 32 bytes of ENCRYPT(k, 2^64 − 1, ε, zeros). */
	rekey(): void {
		if (!this.key) {
			throw new NoiseError("Cannot rekey a CipherState without a key");
		}
		this.key = chacha20poly1305(this.key, REKEY_NONCE, new Uint8Array(0))
			.encrypt(new Uint8Array(KEYLEN))
			.subarray(0, KEYLEN);
	}

	private checkNonce(): void {
		if (this.nonce >= Number.MAX_SAFE_INTEGER) {
			throw new NoiseError("Nonce exhausted");
		}
	}
}

/** The chaining key, the handshake hash and a CipherState (§5.2). */
export class SymmetricState {
	readonly cipher = new CipherState();
	private chainingKey: Uint8Array;
	private h: Uint8Array;

	constructor(protocolName: string) {
		const name = utf8Encode(protocolName);
		if (name.length <= HASHLEN) {
			this.h = new Uint8Array(HASHLEN);
			this.h.set(name);
		} else {
			this.h = hash(name);
		}
		this.chainingKey = this.h;
	}

	get handshakeHash(): Uint8Array {
		return this.h;
	}

	mixKey(inputKeyMaterial: Uint8Array): void {
		const [chainingKey, tempKey] = hkdf(this.chainingKey, inputKeyMaterial, 2);
		this.chainingKey = chainingKey as Uint8Array;
		this.cipher.initializeKey(tempKey as Uint8Array);
	}

	mixHash(data: Uint8Array): void {
		this.h = hash(concatBytes(this.h, data));
	}

	mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
		const [chainingKey, tempHash, tempKey] = hkdf(
			this.chainingKey,
			inputKeyMaterial,
			3,
		);
		this.chainingKey = chainingKey as Uint8Array;
		this.mixHash(tempHash as Uint8Array);
		this.cipher.initializeKey(tempKey as Uint8Array);
	}

	encryptAndHash(plaintext: Uint8Array): Uint8Array {
		const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	decryptAndHash(ciphertext: Uint8Array): Uint8Array {
		const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}

	/** Returns the initiator's sending and receiving CipherStates, in that order. */
	split(): [CipherState, CipherState] {
		const [key1, key2] = hkdf(this.chainingKey, new Uint8Array(0), 2);
		return [
			new CipherState(key1 as Uint8Array),
			new CipherState(key2 as Uint8Array),
		];
	}
}

export interface HandshakeOptions {
	prologue: Uint8Array;
	psk: Uint8Array;
	/** Fixes the ephemeral key, for test vectors only. */
	ephemeralPrivateKey?: Uint8Array;
}

export interface InitiatorHandshakeOptions extends HandshakeOptions {
	/** The responder's static public key, known in advance (`<- s`). */
	remoteStaticPublicKey: Uint8Array;
}

export interface ResponderHandshakeOptions extends HandshakeOptions {
	staticKeyPair: KeyPair;
}

/** The result of a finished handshake. */
export interface HandshakeResult {
	/** Encrypts what this side sends. */
	send: CipherState;
	/** Decrypts what this side receives. */
	receive: CipherState;
	/** The final handshake hash `h`. */
	handshakeHash: Uint8Array;
	/** The other side's ephemeral public key. */
	remoteEphemeralPublicKey: Uint8Array;
}

/**
 * The NKpsk0 HandshakeState (§5.3), for one side. Call `writeMessage` and
 * `readMessage` in turn: the initiator writes message 1 and reads message 2,
 * the responder the other way round. After message 2 `result` is set.
 */
export class HandshakeState {
	readonly initiator: boolean;
	private readonly symmetric = new SymmetricState(PROTOCOL_NAME);
	private readonly psk: Uint8Array;
	private readonly staticKeyPair: KeyPair | undefined;
	private readonly remoteStatic: Uint8Array;
	private readonly fixedEphemeral: Uint8Array | undefined;
	private ephemeral: KeyPair | undefined;
	private remoteEphemeral: Uint8Array | undefined;
	private step = 0;
	result: HandshakeResult | undefined;

	private constructor(
		initiator: boolean,
		options: HandshakeOptions & {
			staticKeyPair?: KeyPair;
			remoteStaticPublicKey: Uint8Array;
		},
	) {
		if (options.psk.length !== 32) {
			throw new NoiseError("The psk is 32 bytes");
		}
		if (options.remoteStaticPublicKey.length !== DHLEN) {
			throw new NoiseError("The responder's static key is 32 bytes");
		}
		this.initiator = initiator;
		this.psk = options.psk;
		this.staticKeyPair = options.staticKeyPair;
		this.remoteStatic = options.remoteStaticPublicKey;
		this.fixedEphemeral = options.ephemeralPrivateKey;
		this.symmetric.mixHash(options.prologue);
		// The pre-message `<- s`: both sides hash the responder's static key.
		this.symmetric.mixHash(this.remoteStatic);
	}

	static initiator(options: InitiatorHandshakeOptions): HandshakeState {
		return new HandshakeState(true, options);
	}

	static responder(options: ResponderHandshakeOptions): HandshakeState {
		return new HandshakeState(false, {
			...options,
			remoteStaticPublicKey: options.staticKeyPair.publicKey,
		});
	}

	get handshakeHash(): Uint8Array {
		return this.symmetric.handshakeHash;
	}

	/** Writes the next handshake message, carrying `payload`. */
	writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
		if (this.step === 0 && this.initiator) {
			// -> psk, e, es
			this.symmetric.mixKeyAndHash(this.psk);
			const e = this.writeEphemeral();
			this.symmetric.mixKey(dh(this.ephemeralKeyPair(), this.remoteStatic));
			const message = concatBytes(e, this.symmetric.encryptAndHash(payload));
			this.step = 1;
			return this.checkLength(message);
		}
		if (this.step === 1 && !this.initiator) {
			// <- e, ee
			const e = this.writeEphemeral();
			this.symmetric.mixKey(
				dh(this.ephemeralKeyPair(), this.remoteEphemeralKey()),
			);
			const message = concatBytes(e, this.symmetric.encryptAndHash(payload));
			this.finish();
			return this.checkLength(message);
		}
		throw new NoiseError("Not this side's turn to write");
	}

	/** Reads the next handshake message and returns its payload. */
	readMessage(message: Uint8Array): Uint8Array {
		if (message.length > MAX_MESSAGE_LENGTH) {
			throw new NoiseError("Handshake message too long");
		}
		if (message.length < DHLEN + TAGLEN) {
			throw new NoiseError("Handshake message too short");
		}
		const e = message.subarray(0, DHLEN);
		const rest = message.subarray(DHLEN);
		if (this.step === 0 && !this.initiator) {
			// -> psk, e, es
			this.symmetric.mixKeyAndHash(this.psk);
			this.readEphemeral(e);
			this.symmetric.mixKey(dh(this.staticKeys(), this.remoteEphemeralKey()));
			const payload = this.symmetric.decryptAndHash(rest);
			this.step = 1;
			return payload;
		}
		if (this.step === 1 && this.initiator) {
			// <- e, ee
			this.readEphemeral(e);
			this.symmetric.mixKey(
				dh(this.ephemeralKeyPair(), this.remoteEphemeralKey()),
			);
			const payload = this.symmetric.decryptAndHash(rest);
			this.finish();
			return payload;
		}
		throw new NoiseError("Not this side's turn to read");
	}

	private writeEphemeral(): Uint8Array {
		this.ephemeral = generateKeyPair(this.fixedEphemeral);
		this.symmetric.mixHash(this.ephemeral.publicKey);
		// The psk modifier (§9.2): `e` also calls MixKey.
		this.symmetric.mixKey(this.ephemeral.publicKey);
		return this.ephemeral.publicKey;
	}

	private readEphemeral(e: Uint8Array): void {
		this.remoteEphemeral = e.slice();
		this.symmetric.mixHash(this.remoteEphemeral);
		this.symmetric.mixKey(this.remoteEphemeral);
	}

	private ephemeralKeyPair(): KeyPair {
		if (!this.ephemeral) {
			throw new NoiseError("No ephemeral key");
		}
		return this.ephemeral;
	}

	private remoteEphemeralKey(): Uint8Array {
		if (!this.remoteEphemeral) {
			throw new NoiseError("No remote ephemeral key");
		}
		return this.remoteEphemeral;
	}

	private staticKeys(): KeyPair {
		if (!this.staticKeyPair) {
			throw new NoiseError("No static key");
		}
		return this.staticKeyPair;
	}

	private finish(): void {
		const [initiatorSend, responderSend] = this.symmetric.split();
		this.result = {
			send: this.initiator ? initiatorSend : responderSend,
			receive: this.initiator ? responderSend : initiatorSend,
			handshakeHash: this.symmetric.handshakeHash,
			remoteEphemeralPublicKey: this.remoteEphemeralKey(),
		};
		this.step = 2;
	}

	private checkLength(message: Uint8Array): Uint8Array {
		if (message.length > MAX_MESSAGE_LENGTH) {
			throw new NoiseError("Handshake message too long");
		}
		return message;
	}
}
