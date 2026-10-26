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
import {
	generateKeyPair,
	HandshakeState,
	type KeyPair,
	type StaticKey,
	staticKey,
} from "./noise.ts";
import {
	type CloseEvent,
	EphemeralCache,
	initiator,
	REKEY_INTERVAL,
	type RelaySession,
	ResumeBuffer,
	reconnectInitiator,
	reconnectResponder,
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
	options: {
		deliver?: boolean;
		cache?: EphemeralCache;
		autoConfirm?: boolean;
	} = {},
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
		autoConfirm: options.autoConfirm,
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

/** A pairing taken as far as CONFIRMED. */
function paired(): Pair {
	const p = pair();
	p.browser.start();
	p.agent.confirm();
	return p;
}

describe("REMEMBER", () => {
	test("the agent side gets the browser's key right after CONFIRMED", () => {
		const p = paired();
		const remembered: Uint8Array[] = [];
		p.agent.onRemember = (key) => remembered.push(key);
		const key = generateKeyPair().publicKey;
		p.browser.remember(key);
		expect(remembered.map(bytesToHex)).toEqual([bytesToHex(key)]);
		p.browser.send("{}");
		expect(p.received.agent).toEqual(["{}"]);
	});

	test("goes once, and only before the first ACP message", () => {
		const p = paired();
		p.browser.remember(generateKeyPair().publicKey);
		expect(() => p.browser.remember(generateKeyPair().publicKey)).toThrow();
		const late = paired();
		late.browser.send("{}");
		expect(() => late.browser.remember(generateKeyPair().publicKey)).toThrow();
	});

	test("not before CONFIRMED, and not from the agent side", () => {
		const p = pair();
		p.browser.start();
		expect(() => p.browser.remember(generateKeyPair().publicKey)).toThrow();
		p.agent.confirm();
		expect(() => p.agent.remember(generateKeyPair().publicKey)).toThrow();
	});
});

interface Reconnect {
	browser: RelaySession;
	agent: RelaySession;
	wire: { from: "browser" | "agent"; data: Uint8Array }[];
	received: { browser: string[]; agent: string[] };
	closed: { browser?: CloseEvent; agent?: CloseEvent };
	events: string[];
}

/** Settles pending promises, so an asynchronous DH can finish. */
async function settle(): Promise<void> {
	for (let index = 0; index < 10; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** A static key whose DH resolves later, as WebCrypto's does. */
function slowStaticKey(keyPair: KeyPair): StaticKey {
	const inner = staticKey(keyPair);
	return {
		publicKey: inner.publicKey,
		dh: (publicKey) =>
			new Promise((resolve, reject) =>
				setTimeout(() => inner.dh(publicKey).then(resolve, reject), 1),
			),
	};
}

function reconnect(
	options: {
		deliver?: boolean;
		agentKnows?: Uint8Array;
		browserKey?: KeyPair;
		resume?: boolean;
		buffers?: { browser: ResumeBuffer; agent: ResumeBuffer };
	} = {},
): Reconnect {
	const deliver = options.deliver ?? true;
	const agentStatic = generateKeyPair();
	const browserStatic = options.browserKey ?? generateKeyPair();
	const room = crypto.getRandomValues(new Uint8Array(16));
	const buffers = options.buffers ?? {
		browser: new ResumeBuffer(),
		agent: new ResumeBuffer(),
	};
	const webOrigin = "https://app.example";
	const result = {
		wire: [],
		received: { browser: [], agent: [] },
		closed: {},
		events: [],
	} as unknown as Reconnect;
	result.browser = reconnectInitiator({
		room,
		webOrigin,
		remoteStaticPublicKey: agentStatic.publicKey,
		staticKey: slowStaticKey(browserStatic),
		resume: options.resume ?? true,
		buffer: buffers.browser,
		send: (data) => {
			result.wire.push({ from: "browser", data });
			if (deliver) result.agent.receive(data);
		},
		onHandshake: () => result.events.push("browser words"),
		onConfirmed: () => result.events.push("browser confirmed"),
		onMessage: (message) => result.received.browser.push(message),
		onClose: (event) => {
			result.closed.browser = event;
		},
	});
	result.agent = reconnectResponder({
		staticKeyPair: agentStatic,
		room,
		webOrigin,
		remoteStaticPublicKey: options.agentKnows ?? browserStatic.publicKey,
		buffer: buffers.agent,
		send: (data) => {
			result.wire.push({ from: "agent", data });
			if (deliver) result.browser.receive(data);
		},
		onHandshake: () => result.events.push("agent words"),
		onKeyConfirmed: () => result.events.push("agent key confirmed"),
		onMessage: (message) => result.received.agent.push(message),
		onClose: (event) => {
			result.closed.agent = event;
		},
	});
	return result;
}

describe("reconnect", () => {
	test("opens with no words, then carries ACP", async () => {
		const r = reconnect();
		r.browser.start();
		await settle();
		expect(r.agent.state).toBe("open");
		expect(r.browser.state).toBe("open");
		expect(r.events).toEqual(["agent key confirmed", "browser confirmed"]);
		r.browser.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		r.agent.send('{"jsonrpc":"2.0","id":1,"result":{}}');
		expect(r.received.agent).toEqual([
			'{"jsonrpc":"2.0","id":1,"method":"initialize"}',
		]);
		expect(r.received.browser).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{}}',
		]);
		expect(() => r.agent.confirm()).toThrow();
		expect(() => r.browser.remember(generateKeyPair().publicKey)).toThrow();
	});

	test("an agent side expecting another browser refuses it", async () => {
		const r = reconnect({ agentKnows: generateKeyPair().publicKey });
		r.browser.start();
		await settle();
		expect(r.agent.state).toBe("closed");
		expect(r.closed.agent?.kind).toBe("error");
		expect(r.browser.state).toBe("handshake");
	});

	test("a browser with another key is refused", async () => {
		const known = generateKeyPair();
		const r = reconnect({
			agentKnows: known.publicKey,
			browserKey: generateKeyPair(),
		});
		r.browser.start();
		await settle();
		expect(r.closed.agent?.kind).toBe("error");
	});

	test("a replayed message 1 never opens the session", async () => {
		const r = reconnect({ deliver: false });
		r.browser.start();
		await settle();
		const message1 = r.wire[0]!.data;
		r.agent.receive(message1);
		await settle();
		// Message 2 went out, but without the browser's PING nothing opens.
		expect(r.wire.filter((entry) => entry.from === "agent")).toHaveLength(1);
		expect(r.agent.state).toBe("handshake");
		expect(r.events).toEqual([]);
	});

	test("frames that arrive while a DH is pending are handled in order", async () => {
		const r = reconnect({ deliver: false });
		r.browser.start();
		await settle();
		r.agent.receive(r.wire[0]!.data);
		await settle();
		const message2 = r.wire[1]!.data;
		r.browser.receive(message2);
		// The browser is still waiting on its DH: hand it a bogus frame now.
		r.browser.receive(new Uint8Array(64));
		await settle();
		expect(r.browser.state).toBe("closed");
		expect(r.closed.browser?.kind).toBe("error");
		// Its PING went out before the bogus frame was read.
		expect(r.wire[2]?.from).toBe("browser");
	});
});

describe("resuming", () => {
	/** A pairing that exchanged one message each way, and its buffers. */
	function history() {
		const p = paired();
		p.browser.send("b1");
		p.agent.send("a1");
		return { browser: p.browser.buffer, agent: p.agent.buffer };
	}

	test("streams carry on, and what was lost in flight is sent again", async () => {
		const buffers = history();
		// Sent while the browser was away, or into its dead socket.
		buffers.agent.add("a2");
		buffers.agent.add("a3");
		buffers.browser.add("b2");
		const r = reconnect({ buffers });
		r.browser.start();
		await settle();
		expect(r.browser.resumed).toBe(true);
		expect(r.agent.resumed).toBe(true);
		expect(r.received.browser).toEqual(["a2", "a3"]);
		expect(r.received.agent).toEqual(["b2"]);
		r.browser.send("b3");
		r.agent.send("a4");
		expect(r.received.agent).toEqual(["b2", "b3"]);
		expect(r.received.browser).toEqual(["a2", "a3", "a4"]);
		expect(buffers.agent.received).toBe(3);
		expect(buffers.browser.received).toBe(4);
	});

	test("nothing missed: nothing sent again", async () => {
		const buffers = history();
		const r = reconnect({ buffers });
		r.browser.start();
		await settle();
		expect(r.agent.resumed).toBe(true);
		expect(r.received).toEqual({ browser: [], agent: [] });
		r.agent.send("a2");
		expect(r.received.browser).toEqual(["a2"]);
	});

	test("a page that lost everything starts again from stream 1", async () => {
		const buffers = history();
		buffers.agent.add("a2");
		const r = reconnect({
			buffers: { browser: new ResumeBuffer(), agent: buffers.agent },
			resume: false,
		});
		r.browser.start();
		await settle();
		expect(r.agent.state).toBe("open");
		expect(r.agent.resumed).toBe(false);
		expect(r.browser.resumed).toBe(false);
		expect(r.received.browser).toEqual([]);
		r.browser.send("fresh");
		r.agent.send("fresh too");
		expect(r.received.agent).toEqual(["fresh"]);
		expect(r.received.browser).toEqual(["fresh too"]);
	});

	test("the agent side no longer has what the browser missed: both start again", async () => {
		const buffers = { browser: new ResumeBuffer(), agent: new ResumeBuffer(4) };
		const p = pair();
		p.browser.start();
		p.agent.confirm();
		// The pairing used its own buffers; carry on with small ones.
		buffers.agent.add("a1");
		buffers.agent.add("a2-long");
		buffers.agent.add("a3-long");
		buffers.browser.received = 1;
		const r = reconnect({ buffers });
		r.browser.start();
		await settle();
		expect(r.agent.resumed).toBe(false);
		expect(r.browser.resumed).toBe(false);
		expect(r.browser.state).toBe("open");
		expect(r.received.browser).toEqual([]);
		expect(buffers.agent.nextStream).toBe(1);
		expect(buffers.browser.nextStream).toBe(1);
	});

	test("the browser no longer has what the agent side missed: it fails, to start afresh", async () => {
		const buffers = { browser: new ResumeBuffer(2), agent: new ResumeBuffer() };
		buffers.browser.add("b1-long");
		buffers.browser.add("b2-long");
		const r = reconnect({ buffers });
		r.browser.start();
		await settle();
		expect(r.closed.browser?.kind).toBe("error");
	});

	test("ResumeBuffer.after", () => {
		const buffer = new ResumeBuffer();
		expect(buffer.after(0)).toEqual([]);
		expect(buffer.after(1)).toBeUndefined();
		buffer.add("one");
		buffer.add("two");
		expect(buffer.after(0)?.map((entry) => entry.message)).toEqual([
			"one",
			"two",
		]);
		expect(buffer.after(1)?.map((entry) => entry.stream)).toEqual([2]);
		expect(buffer.after(2)).toEqual([]);
		expect(buffer.after(3)).toBeUndefined();
		expect(buffer.after(-1)).toBeUndefined();
	});
});

describe("autoConfirm", () => {
	test("opens once the keys are confirmed, with no words on the agent side", () => {
		const p = pair({ autoConfirm: true });
		p.browser.start();
		expect(p.agent.state).toBe("open");
		expect(p.browser.state).toBe("open");
		expect(p.keyConfirmed.count).toBe(1);
		expect(p.sas.agent).toBeUndefined();
		p.browser.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
		p.agent.send('{"jsonrpc":"2.0","id":1,"result":{}}');
		expect(p.received.agent).toEqual([
			'{"jsonrpc":"2.0","id":1,"method":"initialize"}',
		]);
		expect(p.received.browser).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{}}',
		]);
	});

	test("answers the browser's first PING after confirming", () => {
		const p = pair({ deliver: false, autoConfirm: true });
		p.browser.start();
		pump(p);
		// message 1, message 2, the PING, then CONFIRMED and the PONG from the agent.
		expect(p.wire.map((m) => m.from)).toEqual([
			"browser",
			"agent",
			"browser",
			"agent",
			"agent",
		]);
		expect(p.browser.state).toBe("open");
	});

	test("a replayed message 1 never confirms", () => {
		const p = pair({ deliver: false, autoConfirm: true });
		p.browser.start();
		const message1 = p.wire[0]!.data;
		const sent: Uint8Array[] = [];
		let confirmed = false;
		const replayed = responder({
			staticKeyPair: p.staticKeyPair,
			psk: p.link.psk,
			room: p.link.room,
			webOrigin: p.link.webOrigin,
			autoConfirm: true,
			send: (data) => sent.push(data),
			onKeyConfirmed: () => {
				confirmed = true;
			},
		});
		replayed.receive(message1);
		// It answers with message 2, but without the browser's ephemeral key nothing can follow.
		expect(sent).toHaveLength(1);
		expect(replayed.state).toBe("handshake");
		expect(confirmed).toBe(false);
	});
});

describe("ResumeBuffer snapshots", () => {
	test("round-trip through JSON and resume as before", () => {
		const buffer = new ResumeBuffer();
		buffer.add("one");
		buffer.add("two");
		buffer.add("three");
		buffer.received = 7;
		const restored = ResumeBuffer.restore(
			JSON.parse(JSON.stringify(buffer.snapshot())),
		);
		expect(restored.received).toBe(7);
		expect(restored.nextStream).toBe(4);
		expect(restored.after(1)).toEqual([
			{ stream: 2, message: "two" },
			{ stream: 3, message: "three" },
		]);
		expect(restored.add("four")).toBe(4);
	});

	test("keep the restoring limit", () => {
		const buffer = new ResumeBuffer();
		for (const m of ["aaaa", "bbbb", "cccc"]) buffer.add(m);
		const restored = ResumeBuffer.restore(buffer.snapshot(), 8);
		expect(restored.after(0)).toBeUndefined();
		expect(restored.after(1)).toEqual([
			{ stream: 2, message: "bbbb" },
			{ stream: 3, message: "cccc" },
		]);
	});

	test("refuse what isn't a snapshot", () => {
		for (const bad of [
			{},
			{ received: -1, next: 1, kept: [] },
			{ received: 0, next: 0, kept: [] },
			{
				received: 0,
				next: 3,
				kept: [
					{ stream: 2, message: "x" },
					{ stream: 1, message: "y" },
				],
			},
			{ received: 0, next: 2, kept: [{ stream: 2, message: "x" }] },
			{ received: 0, next: 2, kept: [{ stream: 1, message: 5 }] },
		]) {
			expect(() => ResumeBuffer.restore(bad as never)).toThrow();
		}
	});
});
