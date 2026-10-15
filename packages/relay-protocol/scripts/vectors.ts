/**
 * Writes the framing, SAS and session test vectors in `test-vectors/`.
 * Run it only when the protocol changes on purpose: the tests check the code
 * against the files, and a web client runs the same files.
 *
 *     bun run packages/relay-protocol/scripts/vectors.ts
 */

import {
	base64urlEncode,
	bucketLength,
	bytesToHex,
	chunkMessage,
	controlFrame,
	encodeFrame,
	FrameType,
	generateKeyPair,
	hexToBytes,
	initiator,
	MAX_CHUNK_PAYLOAD,
	MAX_PLAINTEXT_LENGTH,
	responder,
	sasWords,
	utf8Encode,
} from "../src/index.ts";

const directory = new URL("../test-vectors/", import.meta.url);

function pattern(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => index % 251);
}

function frameVector(
	description: string,
	frame: Parameters<typeof encodeFrame>[0],
) {
	return {
		description,
		frame: {
			type: frame.type,
			stream: frame.stream,
			seq: frame.seq,
			final: frame.final,
			payload: bytesToHex(frame.payload),
		},
		plaintext: bytesToHex(encodeFrame(frame)),
	};
}

function withHeader(
	header: {
		type: number;
		stream: number;
		seq: number;
		flags: number;
		length: number;
	},
	size: number,
	payload: Uint8Array = new Uint8Array(0),
): string {
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint8(0, header.type);
	view.setUint32(1, header.stream);
	view.setUint32(5, header.seq);
	view.setUint8(9, header.flags);
	view.setUint32(10, header.length);
	out.set(payload, 14);
	return bytesToHex(out);
}

const initialize = utf8Encode(
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}',
);

const frames = {
	description:
		"Frame plaintexts (before encryption). `valid` round-trips; `invalid` must be refused; `buckets` maps an unpadded length to its padded length; `chunking` gives the frames of one long message, whose bytes are i mod 251; `streams` are frame sequences a receiver must accept or refuse.",
	valid: [
		frameVector("ACP, one chunk", {
			type: FrameType.ACP,
			stream: 1,
			seq: 0,
			final: true,
			payload: initialize,
		}),
		frameVector("ACP, 300 bytes: the 512 bucket", {
			type: FrameType.ACP,
			stream: 7,
			seq: 2,
			final: false,
			payload: pattern(300),
		}),
		frameVector("ACP, empty", {
			type: FrameType.ACP,
			stream: 2,
			seq: 0,
			final: true,
			payload: new Uint8Array(0),
		}),
		frameVector(
			"CLOSE with a reason",
			controlFrame(FrameType.CLOSE, utf8Encode("bye")),
		),
		frameVector(
			"PING",
			controlFrame(FrameType.PING, Uint8Array.of(1, 2, 3, 4)),
		),
		frameVector(
			"PONG",
			controlFrame(FrameType.PONG, Uint8Array.of(1, 2, 3, 4)),
		),
		frameVector("CONFIRMED", controlFrame(FrameType.CONFIRMED)),
		frameVector(
			"CONFIRMED of a reconnect, resuming after stream 7",
			controlFrame(FrameType.CONFIRMED, Uint8Array.of(0, 0, 0, 7)),
		),
		frameVector(
			"REMEMBER",
			controlFrame(
				FrameType.REMEMBER,
				utf8Encode(base64urlEncode(pattern(32))),
			),
		),
	],
	invalid: [
		{
			description: "unknown type",
			plaintext: withHeader(
				{ type: 7, stream: 0, seq: 0, flags: 1, length: 0 },
				256,
			),
		},
		{
			description: "unknown flag",
			plaintext: withHeader(
				{ type: 1, stream: 1, seq: 0, flags: 3, length: 0 },
				256,
			),
		},
		{
			description: "length past the end",
			plaintext: withHeader(
				{ type: 1, stream: 1, seq: 0, flags: 1, length: 243 },
				256,
			),
		},
		{
			description: "not padded to its bucket",
			plaintext: withHeader(
				{ type: 1, stream: 1, seq: 0, flags: 1, length: 0 },
				512,
			),
		},
		{
			description: "shorter than the smallest bucket",
			plaintext: withHeader(
				{ type: 1, stream: 1, seq: 0, flags: 1, length: 0 },
				14,
			),
		},
		{
			description: "non-zero padding",
			plaintext: `${withHeader({ type: 1, stream: 1, seq: 0, flags: 1, length: 0 }, 255)}01`,
		},
		{
			description: "control frame with a stream",
			plaintext: withHeader(
				{ type: 3, stream: 1, seq: 0, flags: 1, length: 0 },
				256,
			),
		},
		{
			description: "control frame without FINAL",
			plaintext: withHeader(
				{ type: 3, stream: 0, seq: 0, flags: 0, length: 0 },
				256,
			),
		},
		{
			description: "ACP on stream 0",
			plaintext: withHeader(
				{ type: 1, stream: 0, seq: 0, flags: 1, length: 0 },
				256,
			),
		},
		{
			description: "CONFIRMED with a payload that is not a u32",
			plaintext: withHeader(
				{ type: 5, stream: 0, seq: 0, flags: 1, length: 1 },
				256,
				Uint8Array.of(1),
			),
		},
		{
			description: "REMEMBER with a short key",
			plaintext: withHeader(
				{ type: 6, stream: 0, seq: 0, flags: 1, length: 42 },
				256,
				utf8Encode(base64urlEncode(pattern(32)).slice(0, 42)),
			),
		},
	],
	buckets: [
		0,
		14,
		256,
		257,
		512,
		513,
		4000,
		32768,
		32769,
		MAX_PLAINTEXT_LENGTH,
	].map((length) => ({ length, padded: bucketLength(length) })),
	chunking: (() => {
		const length = MAX_CHUNK_PAYLOAD * 2 + 100;
		return {
			stream: 3,
			length,
			frames: chunkMessage(3, pattern(length)).map((frame) => ({
				seq: frame.seq,
				final: frame.final,
				payloadLength: frame.payload.length,
				plaintextLength: encodeFrame(frame).length,
			})),
		};
	})(),
	streams: [
		{
			description: "two messages, the second in two chunks",
			frames: [
				{ stream: 1, seq: 0, final: true },
				{ stream: 2, seq: 0, final: false },
				{ stream: 2, seq: 1, final: true },
			],
			messages: 2,
		},
		{
			description: "first stream is not 1",
			frames: [{ stream: 2, seq: 0, final: true }],
			error: true,
		},
		{
			description: "a stream skipped",
			frames: [
				{ stream: 1, seq: 0, final: true },
				{ stream: 3, seq: 0, final: true },
			],
			error: true,
		},
		{
			description: "a stream repeated",
			frames: [
				{ stream: 1, seq: 0, final: true },
				{ stream: 1, seq: 0, final: true },
			],
			error: true,
		},
		{
			description: "a chunk skipped",
			frames: [
				{ stream: 1, seq: 0, final: false },
				{ stream: 1, seq: 2, final: true },
			],
			error: true,
		},
		{
			description: "a chunk repeated",
			frames: [
				{ stream: 1, seq: 0, final: false },
				{ stream: 1, seq: 0, final: true },
			],
			error: true,
		},
		{
			description: "streams interleaved",
			frames: [
				{ stream: 1, seq: 0, final: false },
				{ stream: 2, seq: 0, final: true },
			],
			error: true,
		},
		{
			description: "first chunk not seq 0",
			frames: [{ stream: 1, seq: 1, final: true }],
			error: true,
		},
		{
			description: "CLOSE inside a stream",
			frames: [{ stream: 1, seq: 0, final: false }, "close"],
			error: true,
		},
	],
};

const sasInputs = [
	new Uint8Array(32),
	new Uint8Array(32).fill(0xff),
	Uint8Array.from({ length: 32 }, (_, index) => index),
	hexToBytes(
		"6bd69bd4066f41f32e47134976f5bf01606f7a4a0e04369fe61158b06f3a144e",
	),
];
const sas = {
	description:
		'SAS words: BLAKE2s("acpantenna-sas" || h), first 44 bits, four 11-bit indexes into the BIP-39 English list.',
	vectors: sasInputs.map((h) => ({ h: bytesToHex(h), words: sasWords(h) })),
};

// A whole pairing with fixed keys, to check two implementations byte for byte.
const fixed = {
	webOrigin: "https://app.example",
	room: Uint8Array.from({ length: 16 }, (_, index) => index),
	responderStatic: hexToBytes(
		"4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
	),
	psk: new Uint8Array(32).fill(0x42),
	initiatorEphemeral: hexToBytes(
		"893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
	),
	responderEphemeral: hexToBytes(
		"bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
	),
	expiry: 1_800_000_000,
};
const staticKeyPair = generateKeyPair(fixed.responderStatic);
const transcript: { from: string; hex: string }[] = [];
let sasResult: string[] = [];
let handshakeHash = "";
const link = {
	webOrigin: fixed.webOrigin,
	room: fixed.room,
	staticPublicKey: staticKeyPair.publicKey,
	psk: fixed.psk,
	expiry: fixed.expiry,
};
const browser = initiator({
	link,
	ephemeralPrivateKey: fixed.initiatorEphemeral,
	send: (data) => {
		transcript.push({ from: "browser", hex: bytesToHex(data) });
		agent.receive(data);
	},
	onHandshake: (info) => {
		handshakeHash = bytesToHex(info.handshakeHash);
	},
});
const agent = responder({
	staticKeyPair,
	psk: fixed.psk,
	room: fixed.room,
	webOrigin: fixed.webOrigin,
	ephemeralPrivateKey: fixed.responderEphemeral,
	send: (data) => {
		transcript.push({ from: "agent", hex: bytesToHex(data) });
		browser.receive(data);
	},
	onHandshake: (info) => {
		sasResult = info.sas;
	},
});
browser.start();
agent.confirm();
browser.send(
	'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}',
);
agent.send('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}');
browser.close("done");

const { encodeLink } = await import("../src/link.ts");
const session = {
	description:
		"One pairing with fixed keys: message 1, message 2, the browser's PING and the PONG, CONFIRMED, one ACP message each way, then CLOSE. `transcript` is every binary relay message in order.",
	webOrigin: fixed.webOrigin,
	room: bytesToHex(fixed.room),
	responderStaticPrivate: bytesToHex(fixed.responderStatic),
	responderStaticPublic: bytesToHex(staticKeyPair.publicKey),
	psk: bytesToHex(fixed.psk),
	initiatorEphemeralPrivate: bytesToHex(fixed.initiatorEphemeral),
	responderEphemeralPrivate: bytesToHex(fixed.responderEphemeral),
	link: encodeLink(link),
	handshakeHash,
	sas: sasResult,
	messages: [
		{
			from: "browser",
			acp: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}',
		},
		{
			from: "agent",
			acp: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}',
		},
	],
	closeReason: "done",
	transcript,
};

for (const [name, value] of Object.entries({ frames, sas, session })) {
	await Bun.write(
		new URL(`${name}.json`, directory),
		`${JSON.stringify(value, null, "\t")}\n`,
	);
}
