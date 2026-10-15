import { describe, expect, test } from "bun:test";
import vector from "../test-vectors/session.json";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
	chunkMessage,
	controlFrame,
	encodeFrame,
	FrameType,
} from "./frames.ts";
import { type PairingLink, parseLink, prologue } from "./link.ts";
import { generateKeyPair, HandshakeState, type KeyPair } from "./noise.ts";
import {
	type CloseEvent,
	EphemeralCache,
	initiator,
	REKEY_INTERVAL,
	type RelaySession,
	responder,
} from "./session.ts";

interface Pair {
	browser: RelaySession;
	agent: RelaySession;
	/** Binary messages each side put on the wire, in order. */
	wire: { from: "browser" | "agent"; data: Uint8Array }[];
	received: { browser: string[]; agent: string[] };
	closed: { browser?: CloseEvent; agent?: CloseEvent };
	sas: { browser?: string[]; agent?: string[] };
	keyConfirmed: { count: number };
	link: PairingLink;
	staticKeyPair: KeyPair;
}

/**
 * Two sessions joined back to back. With `deliver` false, messages are only
 * recorded, so a test can tamper with them before handing them over.
 */
function pair(
	options: { deliver?: boolean; cache?: EphemeralCache } = {},
): Pair {
	const deliver = options.deliver ?? true;
	const staticKeyPair = generateKeyPair();
	const link: PairingLink = {
		webOrigin: "https://app.example",
		room: crypto.getRandomValues(new Uint8Array(16)),
		staticPublicKey: staticKeyPair.publicKey,
		psk: crypto.getRandomValues(new Uint8Array(32)),
		expiry: Math.floor(Date.now() / 1000) + 600,
	};
	const result: Pair = {
		wire: [],
		received: { browser: [], agent: [] },
		closed: {},
		sas: {},
		keyConfirmed: { count: 0 },
		link,
		staticKeyPair,
	} as unknown as Pair;
	result.browser = initiator({
		link,
		send: (data) => {
			result.wire.push({ from: "browser", data });
			if (deliver) result.agent.receive(data);
		},
		onHandshake: (info) => {
			result.sas.browser = info.sas;
		},
		onMessage: (message) => result.received.browser.push(message),
		onClose: (event) => {
			result.closed.browser = event;
		},
	});
	result.agent = responder({
		staticKeyPair,
		psk: link.psk,
		room: link.room,
		webOrigin: link.webOrigin,
		acceptEphemeral: options.cache?.accept,
		send: (data) => {
			result.wire.push({ from: "agent", data });
			if (deliver) result.browser.receive(data);
		},
		onHandshake: (info) => {
			result.sas.agent = info.sas;
		},
		onKeyConfirmed: () => {
			result.keyConfirmed.count++;
		},
		onMessage: (message) => result.received.agent.push(message),
		onClose: (event) => {
			result.closed.agent = event;
		},
	});
	return result;
}

describe("session vector", () => {
	test("reproduces the transcript byte for byte", () => {
		const link = parseLink(vector.link);
		const staticKeyPair = generateKeyPair(
			hexToBytes(vector.responderStaticPrivate),
		);
		expect(bytesToHex(link.staticPublicKey)).toBe(vector.responderStaticPublic);
		const wire: { from: string; hex: string }[] = [];
		let words: string[] = [];
		const agentMessages: string[] = [];
		const browserMessages: string[] = [];
		let closeReason = "";
		const browser = initiator({
			link,
			ephemeralPrivateKey: hexToBytes(vector.initiatorEphemeralPrivate),
			send: (data) => {
				wire.push({ from: "browser", hex: bytesToHex(data) });
				agent.receive(data);
			},
			onMessage: (message) => browserMessages.push(message),
		});
		const agent = responder({
			staticKeyPair,
			psk: hexToBytes(vector.psk),
			room: hexToBytes(vector.room),
			webOrigin: vector.webOrigin,
			ephemeralPrivateKey: hexToBytes(vector.responderEphemeralPrivate),
			send: (data) => {
				wire.push({ from: "agent", hex: bytesToHex(data) });
				browser.receive(data);
			},
			onHandshake: (info) => {
				words = info.sas;
				expect(bytesToHex(info.handshakeHash)).toBe(vector.handshakeHash);
			},
			onMessage: (message) => agentMessages.push(message),
			onClose: (event) => {
				if (event.kind === "ended") closeReason = event.reason;
			},
		});
		browser.start();
		agent.confirm();
		const [fromBrowser, fromAgent] = vector.messages;
		browser.send(fromBrowser!.acp);
		agent.send(fromAgent!.acp);
		browser.close(vector.closeReason);
		expect(words).toEqual(vector.sas);
		expect(wire).toEqual(vector.transcript);
		expect(agentMessages).toEqual([fromBrowser!.acp]);
		expect(browserMessages).toEqual([fromAgent!.acp]);
		expect(closeReason).toBe(vector.closeReason);
	});
});

/** Hands every message not yet delivered to the other side, in order, until none are left. */
function pump(p: Pair, from = 0): number {
	let index = from;
	for (; index < p.wire.length; index++) {
		const message = p.wire[index]!;
		(message.from === "browser" ? p.agent : p.browser).receive(message.data);
	}
	return index;
}

/** Pairs two undelivering sessions up to CONFIRMED; returns how far the wire is delivered. */
function pairUp(p: Pair): number {
	p.browser.start();
	const delivered = pump(p);
	p.agent.confirm();
	return pump(p, delivered);
}

describe("session", () => {
	test("pairs, shows the same SAS on both sides, then carries ACP", () => {
		const p = pair();
		let confirmed = false;
		p.browser.onConfirmed = () => {
			confirmed = true;
		};
		p.browser.start();
		expect(p.agent.state).toBe("pairing");
		expect(p.browser.state).toBe("pairing");
		expect(p.keyConfirmed.count).toBe(1);
		expect(p.sas.agent).toHaveLength(4);
		expect(p.sas.browser).toEqual(p.sas.agent!);
		expect(() => p.browser.send("{}")).toThrow();
		expect(() => p.agent.send("{}")).toThrow();
		p.agent.confirm();
		expect(confirmed).toBe(true);
		p.browser.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		p.agent.send('{"jsonrpc":"2.0","id":1,"result":{}}');
		expect(p.received.agent).toEqual([
			'{"jsonrpc":"2.0","id":1,"method":"initialize"}',
		]);
		expect(p.received.browser).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{}}',
		]);
	});

	test("the agent side shows the words only after the browser's PING decrypts", () => {
		const p = pair({ deliver: false });
		p.browser.start();
		p.agent.receive(p.wire[0]!.data);
		expect(p.agent.state).toBe("handshake");
		expect(p.agent.handshakeInfo).toBeUndefined();
		expect(p.sas.agent).toBeUndefined();
		expect(() => p.agent.confirm()).toThrow();
		p.browser.receive(p.wire[1]!.data);
		expect(p.sas.browser).toHaveLength(4);
		// The browser's first frame went out on its own: a PING.
		expect(p.wire[2]!.from).toBe("browser");
		expect(p.keyConfirmed.count).toBe(0);
		p.agent.receive(p.wire[2]!.data);
		expect(p.keyConfirmed.count).toBe(1);
		expect(p.sas.agent).toEqual(p.sas.browser!);
		expect(p.agent.state).toBe("pairing");
	});

	test("a first frame other than PING is fatal", () => {
		const p = pair({ deliver: false });
		// A browser built by hand, whose first frame is a PONG.
		const browser = HandshakeState.initiator({
			prologue: prologue(p.link.room, p.link.webOrigin),
			psk: p.link.psk,
			remoteStaticPublicKey: p.link.staticPublicKey,
		});
		p.agent.receive(browser.writeMessage());
		browser.readMessage(p.wire[0]!.data);
		p.agent.receive(
			browser.result!.send.encryptWithAd(
				new Uint8Array(0),
				encodeFrame(controlFrame(FrameType.PONG)),
			),
		);
		expect(p.closed.agent).toMatchObject({
			kind: "error",
			reason: "The first frame from the browser is a PING",
		});
		expect(p.sas.agent).toBeUndefined();
	});

	test("carries a message larger than one frame", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		const before = p.wire.length;
		const big = JSON.stringify({ text: "x".repeat(200_000), emoji: "🙂" });
		p.agent.send(big);
		expect(p.received.browser).toEqual([big]);
		expect(p.wire.length - before).toBe(4);
	});

	test("pads every transport message to a bucket", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		const before = p.wire.length;
		p.browser.send("{}");
		p.browser.send("x".repeat(300));
		const sizes = p.wire.slice(before).map((m) => m.data.length);
		expect(sizes).toEqual([256 + 16, 512 + 16]);
		// The handshake messages are 48 bytes; everything after is padded.
		expect(p.wire.slice(0, 2).map((m) => m.data.length)).toEqual([48, 48]);
	});

	test("an ACP message before CONFIRMED is fatal", () => {
		const p = pair({ deliver: false });
		p.browser.start();
		const delivered = pump(p);
		expect(p.agent.state).toBe("pairing");
		// A browser that does not wait for CONFIRMED: forge the send by hand.
		(p.browser as unknown as { stateValue: string }).stateValue = "open";
		p.browser.send("{}");
		pump(p, delivered);
		expect(p.closed.agent?.kind).toBe("error");
		expect(p.agent.state).toBe("closed");
	});

	test("a replayed message 1 is refused while the link is valid", () => {
		const cache = new EphemeralCache();
		const first = pair({ deliver: false, cache });
		first.browser.start();
		const message1 = first.wire[0]!.data;
		first.agent.receive(message1);

		// The relay replays message 1 to the agent side's next attempt.
		const closed: CloseEvent[] = [];
		const sent: Uint8Array[] = [];
		const replay = responder({
			staticKeyPair: first.staticKeyPair,
			psk: first.link.psk,
			room: first.link.room,
			webOrigin: first.link.webOrigin,
			acceptEphemeral: cache.accept,
			send: (data) => sent.push(data),
			onClose: (event) => closed.push(event),
		});
		replay.receive(message1);
		expect(sent).toEqual([]);
		expect(closed).toMatchObject([
			{ kind: "error", reason: "Replayed handshake message" },
		]);
	});

	test("a replayed message 1 never shows words, even without the cache", () => {
		const first = pair({ deliver: false });
		first.browser.start();
		const words: string[][] = [];
		const replay = responder({
			staticKeyPair: first.staticKeyPair,
			psk: first.link.psk,
			room: first.link.room,
			webOrigin: first.link.webOrigin,
			send: () => {},
			onHandshake: (info) => words.push(info.sas),
		});
		replay.receive(first.wire[0]!.data);
		// Whoever replayed it cannot make the PING: they lack the ephemeral key.
		expect(replay.state).toBe("handshake");
		expect(words).toEqual([]);
	});

	test("a flipped bit in a transport message is fatal, and stays fatal", () => {
		const p = pair({ deliver: false });
		const delivered = pairUp(p);
		p.browser.send("{}");
		const tampered = p.wire[delivered]!.data.slice();
		tampered[20] = (tampered[20] ?? 0) ^ 0x80;
		p.agent.receive(tampered);
		expect(p.closed.agent).toMatchObject({
			kind: "error",
			reason: "Decryption failed",
		});
		// The genuine message arriving after does not revive it.
		p.agent.receive(p.wire[delivered]!.data);
		expect(p.received.agent).toEqual([]);
	});

	test("a dropped message is fatal: the nonce no longer matches", () => {
		const p = pair({ deliver: false });
		const delivered = pairUp(p);
		p.browser.send("{}");
		p.browser.send("{}");
		p.agent.receive(p.wire[delivered + 1]!.data);
		expect(p.closed.agent?.kind).toBe("error");
	});

	test("a stream cut short before CLOSE is fatal", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		// Send the first chunk of a two-chunk message, then CLOSE.
		const browser = p.browser as unknown as {
			sendFrame(frame: unknown): void;
		};
		const [first] = chunkMessage(1, new Uint8Array(70_000));
		browser.sendFrame(first);
		p.browser.close("bye");
		expect(p.closed.agent).toMatchObject({
			kind: "error",
			reason: "Stream left without FINAL",
		});
	});

	test("a socket that ends without CLOSE is a lost connection", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		p.agent.transportClosed();
		expect(p.closed.agent).toEqual({
			kind: "lost",
			reason: "connection lost",
		});
	});

	test("an authenticated CLOSE ends both sides", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		p.agent.close("user disconnected");
		expect(p.closed.browser).toEqual({
			kind: "ended",
			reason: "user disconnected",
			byPeer: true,
		});
		expect(p.closed.agent).toEqual({
			kind: "ended",
			reason: "user disconnected",
			byPeer: false,
		});
	});

	test("a tampered message 1 is refused", () => {
		const p = pair({ deliver: false });
		p.browser.start();
		const tampered = p.wire[0]!.data.slice();
		tampered[40] = (tampered[40] ?? 0) ^ 1;
		p.agent.receive(tampered);
		expect(p.closed.agent?.kind).toBe("error");
	});

	test("ping is answered with pong while pairing", () => {
		const p = pair();
		const pongs: string[] = [];
		p.browser.onPong = (payload) => pongs.push(bytesToHex(payload));
		p.browser.start();
		p.browser.ping(Uint8Array.of(9));
		// The automatic first PING has an empty payload.
		expect(pongs).toEqual(["", "09"]);
	});

	test("CONFIRMED from the browser is fatal", () => {
		const p = pair();
		p.browser.start();
		(p.browser as unknown as { sendFrame(frame: unknown): void }).sendFrame({
			type: FrameType.CONFIRMED,
			stream: 0,
			seq: 0,
			final: true,
			payload: new Uint8Array(0),
		});
		expect(p.closed.agent?.kind).toBe("error");
	});

	test("both sides rekey at the same count", () => {
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		for (let index = 0; index < REKEY_INTERVAL + 5; index++) {
			p.browser.send(String(index));
			p.agent.send(String(index));
		}
		expect(p.received.agent).toHaveLength(REKEY_INTERVAL + 5);
		expect(p.received.browser).toHaveLength(REKEY_INTERVAL + 5);
		expect(p.closed.agent).toBeUndefined();
		expect(p.closed.browser).toBeUndefined();
		// 20,000 messages through the cipher: slow on a shared CI runner.
	}, 30_000);
});
