import { describe, expect, test } from "bun:test";
import cacophony from "../test-vectors/noise-nkpsk0.json";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
	CipherState,
	generateKeyPair,
	HandshakeState,
	NoiseError,
	PROTOCOL_NAME,
} from "./noise.ts";

describe("Noise NKpsk0 against the cacophony vectors", () => {
	const vectors = cacophony.vectors.filter(
		(vector) => vector.protocol_name === PROTOCOL_NAME,
	);

	test("the fixture has vectors for this protocol", () => {
		expect(vectors.length).toBeGreaterThan(0);
	});

	for (const vector of vectors) {
		test(vector.protocol_name, () => {
			const responderStatic = generateKeyPair(hexToBytes(vector.resp_static));
			expect(bytesToHex(responderStatic.publicKey)).toBe(
				vector.init_remote_static,
			);
			const initiator = HandshakeState.initiator({
				prologue: hexToBytes(vector.init_prologue),
				psk: hexToBytes(vector.init_psks[0] as string),
				remoteStaticPublicKey: hexToBytes(vector.init_remote_static),
				ephemeralPrivateKey: hexToBytes(vector.init_ephemeral),
			});
			const responder = HandshakeState.responder({
				prologue: hexToBytes(vector.resp_prologue),
				psk: hexToBytes(vector.resp_psks[0] as string),
				staticKeyPair: responderStatic,
				ephemeralPrivateKey: hexToBytes(vector.resp_ephemeral),
			});

			const [first, second, ...transport] = vector.messages;
			if (!first || !second) {
				throw new Error("A vector has at least two messages");
			}

			const message1 = initiator.writeMessage(hexToBytes(first.payload));
			expect(bytesToHex(message1)).toBe(first.ciphertext);
			expect(bytesToHex(responder.readMessage(message1))).toBe(first.payload);

			const message2 = responder.writeMessage(hexToBytes(second.payload));
			expect(bytesToHex(message2)).toBe(second.ciphertext);
			expect(bytesToHex(initiator.readMessage(message2))).toBe(second.payload);

			const initiatorResult = initiator.result!;
			const responderResult = responder.result!;
			expect(bytesToHex(initiatorResult.handshakeHash)).toBe(
				vector.handshake_hash,
			);
			expect(bytesToHex(responderResult.handshakeHash)).toBe(
				vector.handshake_hash,
			);

			// Transport messages in the vectors alternate, the initiator first.
			transport.forEach((message, index) => {
				const fromInitiator = index % 2 === 0;
				const sender = fromInitiator ? initiatorResult : responderResult;
				const receiver = fromInitiator ? responderResult : initiatorResult;
				const ciphertext = sender.send.encryptWithAd(
					new Uint8Array(0),
					hexToBytes(message.payload),
				);
				expect(bytesToHex(ciphertext)).toBe(message.ciphertext);
				expect(
					bytesToHex(
						receiver.receive.decryptWithAd(new Uint8Array(0), ciphertext),
					),
				).toBe(message.payload);
			});
		});
	}
});

describe("Noise NKpsk0", () => {
	function pair(options?: { responderPsk?: Uint8Array; prologue?: string }) {
		const staticKeyPair = generateKeyPair();
		const psk = new Uint8Array(32).fill(7);
		const initiator = HandshakeState.initiator({
			prologue: new TextEncoder().encode("p"),
			psk,
			remoteStaticPublicKey: staticKeyPair.publicKey,
		});
		const responder = HandshakeState.responder({
			prologue: new TextEncoder().encode(options?.prologue ?? "p"),
			psk: options?.responderPsk ?? psk,
			staticKeyPair,
		});
		return { initiator, responder };
	}

	test("completes with matching hashes and keys", () => {
		const { initiator, responder } = pair();
		responder.readMessage(initiator.writeMessage());
		initiator.readMessage(responder.writeMessage());
		expect(initiator.result!.handshakeHash).toEqual(
			responder.result!.handshakeHash,
		);
		const ciphertext = initiator.result!.send.encryptWithAd(
			new Uint8Array(0),
			Uint8Array.of(1, 2, 3),
		);
		expect(
			responder.result!.receive.decryptWithAd(new Uint8Array(0), ciphertext),
		).toEqual(Uint8Array.of(1, 2, 3));
	});

	test("a wrong psk is rejected at message 1", () => {
		const { initiator, responder } = pair({
			responderPsk: new Uint8Array(32).fill(8),
		});
		expect(() => responder.readMessage(initiator.writeMessage())).toThrow(
			NoiseError,
		);
	});

	test("a different prologue is rejected at message 1", () => {
		const { initiator, responder } = pair({ prologue: "q" });
		expect(() => responder.readMessage(initiator.writeMessage())).toThrow(
			NoiseError,
		);
	});

	test("a flipped bit in message 2 is rejected", () => {
		const { initiator, responder } = pair();
		responder.readMessage(initiator.writeMessage());
		const message2 = responder.writeMessage();
		message2[40] = (message2[40] ?? 0) ^ 1;
		expect(() => initiator.readMessage(message2)).toThrow(NoiseError);
	});

	test("rekey changes the key on both sides alike", () => {
		const sender = new CipherState(new Uint8Array(32).fill(1));
		const receiver = new CipherState(new Uint8Array(32).fill(1));
		sender.rekey();
		receiver.rekey();
		const ciphertext = sender.encryptWithAd(
			new Uint8Array(0),
			Uint8Array.of(9),
		);
		expect(receiver.decryptWithAd(new Uint8Array(0), ciphertext)).toEqual(
			Uint8Array.of(9),
		);
		const stale = new CipherState(new Uint8Array(32).fill(1));
		stale.encryptWithAd(new Uint8Array(0), Uint8Array.of(0));
		expect(() =>
			stale.decryptWithAd(
				new Uint8Array(0),
				sender.encryptWithAd(new Uint8Array(0), Uint8Array.of(9)),
			),
		).toThrow(NoiseError);
	});
});
