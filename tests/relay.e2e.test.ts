#!/usr/bin/env bun

/// <reference types="bun" />

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChannelLogger } from "@acpantenna/channel";
import { relayChannel } from "@acpantenna/channel-relay";
import {
	type DevRelay,
	startDevRelay,
} from "@acpantenna/channel-relay/dev-relay";
import { normalizeConfig } from "@acpantenna/config";
import { AcpAntennaGateway } from "@acpantenna/core";
import {
	chunkMessage,
	controlFrame,
	encodeFrame,
	FrameType,
	generateKeyPair,
	HandshakeState,
	parseLink,
	prologue,
} from "@acpantenna/relay-protocol";
import { RelayBrowser, until } from "./fixtures/relay-browser.ts";

const repoRoot = resolve(import.meta.dir, "..");
const dumbClientPath = join(
	repoRoot,
	"packages",
	"acp-dumb-client",
	"src",
	"main.ts",
);

const silentLogger: ChannelLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

let relay: DevRelay;

beforeAll(() => {
	relay = startDevRelay();
});

afterAll(async () => {
	await relay.stop();
});

interface Harness {
	gateway: AcpAntennaGateway;
	workDir: string;
	/** Connects the dumb agent through the relay channel; resolves to the link. */
	connect(
		conversationId?: string,
	): Promise<{ link: string; sessionId: string }>;
	stop(): Promise<void>;
}

async function startHarness(
	options: { agentArgs?: string[]; channel?: Record<string, unknown> } = {},
): Promise<Harness> {
	mkdirSync(join(repoRoot, "out"), { recursive: true });
	const root = mkdtempSync(join(repoRoot, "out", "acpantenna-relay-"));
	const workDir = join(root, "project");

	mkdirSync(workDir);

	const config = normalizeConfig({
		agents: {
			dumb: {
				command: "bun",
				args: [
					dumbClientPath,
					"--load-session",
					"--replay",
					"--echo-context",
					"--echo-mcp",
					"--modes",
					...(options.agentArgs ?? []),
				],
				cwd: repoRoot,
			},
		},
		channels: {
			web: {
				type: "relay",
				relayUrl: relay.url,
				webOrigin: "https://app.example",
				keyStorage: "file",
				coalesceMs: 20,
				...options.channel,
			},
		},
		mcpServers: [{ name: "configured", command: "configured-mcp" }],
		state: { driver: "sqlite", path: join(root, "state.sqlite") },
	});
	const gateway = new AcpAntennaGateway({
		config,
		channelFactories: { relay: relayChannel.create },
		logger: silentLogger,
	});

	await gateway.start();

	return {
		gateway,
		workDir,
		connect: async (conversationId = "c1") => {
			const connection = await gateway.connect({
				channelId: "web",
				conversationId,
				agentId: "dumb",
				cwd: workDir,
			});
			const pairing = gateway.pairing({ channelId: "web", conversationId });

			expect(pairing?.state).toBe("waiting");

			return { link: pairing?.link ?? "", sessionId: connection.acpSessionId };
		},
		stop: async () => {
			await gateway.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Opens the link, checks the words match, confirms them on the agent side. */
async function pair(
	harness: Harness,
	link: string,
	conversationId = "c1",
	options: { remember?: boolean } = {},
): Promise<RelayBrowser> {
	const browser = await RelayBrowser.open(link, relay.url, options);
	const target = { channelId: "web", conversationId };

	await until(
		() => harness.gateway.pairing(target)?.state === "verifying",
		5000,
		"the words",
	);
	expect(harness.gateway.pairing(target)?.words).toEqual(browser.words!);
	await harness.gateway.confirmPairing(target, true);
	await browser.confirmed;
	expect(harness.gateway.pairing(target)?.state).toBe("connected");

	return browser;
}

const prompt = (sessionId: string, text: string) => ({
	sessionId,
	prompt: [{ type: "text", text }],
});

test("pairs, checks the words, then runs initialize, session/list, session/load and session/prompt", async () => {
	const harness = await startHarness();

	try {
		const { link, sessionId } = await harness.connect();

		expect(link).toStartWith("https://app.example/#v1.");
		const browser = await pair(harness, link);

		const initialized = await browser.rpc("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: true }, terminal: true },
		});
		expect(initialized.result).toEqual({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: { http: false, sse: false },
				sessionCapabilities: { list: {} },
			},
			authMethods: [],
			agentInfo: expect.objectContaining({ name: "acpantenna-dumb-client" }),
		});

		const listed = await browser.rpc("session/list", {});
		expect(listed.result).toEqual({
			sessions: [{ sessionId, cwd: harness.workDir }],
		});

		// The browser's directory and MCP servers are ignored.
		const loaded = await browser.rpc("session/load", {
			sessionId,
			cwd: "/somewhere/else",
			mcpServers: [{ name: "evil", command: "rm", args: ["-rf", "/"] }],
		});
		expect(loaded.error).toBeUndefined();
		// The load replays the conversation to the browser, as it asked.
		await until(() => browser.text().includes("old answer"));

		const prompted = await browser.rpc(
			"session/prompt",
			prompt(sessionId, "hi"),
		);
		expect(prompted.result).toEqual({ stopReason: "end_turn" });
		await until(() => browser.text().includes("dumb client: hi"));
		expect(browser.text()).toContain(
			`[${sessionId} ${harness.workDir}] [mcp: configured] [ask] dumb client: hi`,
		);

		const moded = await browser.rpc("session/set_mode", {
			sessionId,
			modeId: "trusted",
		});
		expect(moded.error).toBeUndefined();

		expect(await harness.gateway.listConnections()).toEqual([
			expect.objectContaining({ channelId: "web", acpSessionId: sessionId }),
		]);
		browser.close();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("refuses what the proxy does not allow", async () => {
	const harness = await startHarness();

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link);

		await browser.rpc("initialize", { protocolVersion: 1 });

		for (const method of [
			"authenticate",
			"session/fork",
			"session/close",
			"session/delete",
			"fs/read_text_file",
			"terminal/create",
			"_vendor/anything",
		]) {
			const answer = await browser.rpc(method, { sessionId });
			expect(answer.error?.code).toBe(-32601);
		}

		// Another session is not this connection's.
		for (const method of [
			"session/load",
			"session/resume",
			"session/prompt",
			"session/set_mode",
			"session/set_config_option",
		]) {
			const answer = await browser.rpc(method, {
				...prompt("someone-elses", "hi"),
				cwd: "/",
				modeId: "trusted",
				configId: "x",
				value: "y",
			});
			expect(answer.error?.code).toBe(-32602);
		}

		// The browser's own ids come back as they were, strings and numbers alike.
		const byString = await browser.rpc("session/list", {}, "my-id");
		expect(byString.result).toBeDefined();
		expect(browser.received.some((message) => message.id === "my-id")).toBe(
			true,
		);
		browser.close();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("session/new rebinds the connection, in its own directory with the configured MCP servers", async () => {
	const harness = await startHarness();

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link);

		const created = await browser.rpc("session/new", {
			cwd: "/tmp/evil",
			mcpServers: [{ name: "evil", command: "curl", args: ["evil.example"] }],
		});
		const newId = (created.result as { sessionId: string }).sessionId;

		expect(newId).not.toBe(sessionId);
		expect((await browser.rpc("session/list", {})).result).toEqual({
			sessions: [{ sessionId: newId, cwd: harness.workDir }],
		});
		// The old session is no longer the connection's.
		expect(
			(await browser.rpc("session/prompt", prompt(sessionId, "x"))).error?.code,
		).toBe(-32602);

		await browser.rpc("session/prompt", prompt(newId, "again"));
		await until(() => browser.text().includes("dumb client: again"));
		expect(browser.text()).toContain(
			`[${newId} ${harness.workDir}] [mcp: configured] [ask] dumb client: again`,
		);
		expect(await harness.gateway.listConnections()).toEqual([
			expect.objectContaining({ acpSessionId: newId }),
		]);
		browser.close();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("turns allow-always into allow-once, and answers fs requests itself", async () => {
	const harness = await startHarness({
		agentArgs: ["--ask-permission", "--read-file", "/etc/hostname"],
	});

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link);
		const asked: Array<{ method: string; params: unknown }> = [];

		browser.onRequest = (method, params) => {
			asked.push({ method, params });
			return { outcome: { outcome: "selected", optionId: "always" } };
		};

		await browser.rpc("session/prompt", prompt(sessionId, "write"));
		await until(() => browser.text().includes("[fs:"));

		expect(browser.text()).toContain("[permission: once]");
		// The agent asked to read a file: refused here, never put to the browser.
		expect(browser.text()).toContain("[fs: refused -32601]");
		expect(asked.map((request) => request.method)).toEqual([
			"session/request_permission",
		]);
		browser.close();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a link expires, and the connection with it", async () => {
	const harness = await startHarness({ channel: { linkTtlSeconds: 1 } });

	try {
		const { link } = await harness.connect();

		await until(
			async () => (await harness.gateway.listConnections()).length === 0,
			5000,
			"the connection to end",
		);

		// Its room is gone from the relay: a browser gets nowhere.
		const late = await RelayBrowser.open(link, relay.url);
		await until(() => late.socketClosed !== undefined);
		expect(late.statuses).toEqual([{ t: "closed", reason: "ttl" }]);
		expect(late.words).toBeUndefined();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a link works once: after a browser has paired, no other can", async () => {
	const harness = await startHarness();

	try {
		const { link } = await harness.connect();
		const first = await RelayBrowser.open(link, relay.url);

		// The keys are confirmed (the words are up): the psk is spent.
		await until(
			() =>
				harness.gateway.pairing({ channelId: "web", conversationId: "c1" })
					?.state === "verifying",
		);

		// A second browser while the first is there: the room is full.
		const second = await RelayBrowser.open(link, relay.url);
		await until(() => second.socketClosed !== undefined);
		expect(second.socketClosed?.code).toBe(4009);

		// The first leaves before the words are confirmed: the link is spent,
		// so the connection ends rather than waiting for another browser.
		first.close();
		await until(
			async () => (await harness.gateway.listConnections()).length === 0,
			5000,
			"the connection to end",
		);
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a replayed message 1 neither pairs nor spends the link", async () => {
	const harness = await startHarness();

	try {
		const { link } = await harness.connect();
		const parsed = parseLink(link);
		const target = { channelId: "web", conversationId: "c1" };

		// A browser sends message 1 and goes, before it confirms the keys.
		const recorded = await RelayBrowser.open(link, relay.url, {
			handshake: false,
		});
		await until(() => recorded.statuses.some((status) => status.t === "ready"));
		const handshake = HandshakeState.initiator({
			prologue: prologue(parsed.room, parsed.webOrigin),
			psk: parsed.psk,
			remoteStaticPublicKey: parsed.staticPublicKey,
		});
		const message1 = handshake.writeMessage();
		const answers: Uint8Array[] = [];

		recorded.socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				answers.push(new Uint8Array(event.data as ArrayBuffer));
			}
		});
		recorded.socket.send(message1);
		await until(() => answers.length === 1, 5000, "message 2");
		recorded.close();
		await until(() => recorded.socketClosed !== undefined);

		// Whoever recorded it replays it: no answer, no words.
		const replayer = await RelayBrowser.open(link, relay.url, {
			handshake: false,
		});
		const replayAnswers: unknown[] = [];

		replayer.socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				replayAnswers.push(event.data);
			}
		});
		await until(() => replayer.statuses.some((status) => status.t === "ready"));
		replayer.socket.send(message1);
		await Bun.sleep(300);
		expect(replayAnswers).toEqual([]);
		expect(harness.gateway.pairing(target)?.state).toBe("waiting");
		replayer.close();
		await until(() => replayer.socketClosed !== undefined);

		// The link still works for the real browser.
		const browser = await pair(harness, link);
		expect(browser.words).toHaveLength(4);
		browser.close();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a bad tag is fatal: the connection ends", async () => {
	const harness = await startHarness();

	try {
		const { link } = await harness.connect();
		const browser = await pair(harness, link);
		const session = browser.session as unknown as {
			sendCipher: {
				encryptWithAd(ad: Uint8Array, data: Uint8Array): Uint8Array;
			};
		};
		const frame = session.sendCipher.encryptWithAd(
			new Uint8Array(0),
			encodeFrame(controlFrame(FrameType.PING)),
		);

		frame[30] = (frame[30] ?? 0) ^ 1;
		browser.socket.send(frame);

		await until(
			async () => (await harness.gateway.listConnections()).length === 0,
			5000,
			"the connection to end",
		);
		// Nothing more is said: there is no resync after a bad tag.
		expect(browser.closeEvent?.kind).not.toBe("ended");
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a stream cut short before CLOSE is fatal", async () => {
	const harness = await startHarness();

	try {
		const { link } = await harness.connect();
		const browser = await pair(harness, link);
		const session = browser.session as unknown as {
			sendFrame(frame: unknown): void;
		};
		const [first] = chunkMessage(1, new Uint8Array(100_000).fill(32));

		session.sendFrame(first);
		browser.session?.close("bye");

		await until(
			async () => (await harness.gateway.listConnections()).length === 0,
			5000,
			"the connection to end",
		);
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a remembered browser leaves mid-turn, comes back, and misses nothing", async () => {
	const harness = await startHarness();
	const target = { channelId: "web", conversationId: "c1" };

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link, "c1", { remember: true });

		await until(() => browser.staticKeyPair !== undefined);
		await browser.rpc("initialize", { protocolVersion: 1 });

		// The phone locks right after sending: the answer comes while it is away.
		const answer = browser.rpc("session/prompt", prompt(sessionId, "hi"));
		browser.close();
		await until(
			() => harness.gateway.pairing(target)?.away === true,
			5000,
			"the browser to be away",
		);
		expect(harness.gateway.pairing(target)?.state).toBe("connected");

		await browser.reconnect();
		await browser.confirmed;
		expect(browser.session?.resumed).toBe(true);
		expect((await answer).result).toEqual({ stopReason: "end_turn" });
		expect(browser.text()).toContain("dumb client: hi");
		expect(harness.gateway.pairing(target)?.away).toBeUndefined();

		const again = await browser.rpc(
			"session/prompt",
			prompt(sessionId, "again"),
		);
		expect(again.result).toEqual({ stopReason: "end_turn" });
	} finally {
		await harness.stop();
	}
}, 30_000);

test("a remembered page that lost its state comes back as a new client", async () => {
	const harness = await startHarness();

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link, "c1", { remember: true });

		await until(() => browser.staticKeyPair !== undefined);
		await browser.reconnect({ resume: false });
		await browser.confirmed;
		expect(browser.session?.resumed).toBe(false);

		await browser.rpc("initialize", { protocolVersion: 1 });
		const loaded = await browser.rpc("session/load", {
			sessionId,
			cwd: harness.workDir,
			mcpServers: [],
		});
		expect(loaded.error).toBeUndefined();
		await until(() => browser.text().includes("old answer"));
	} finally {
		await harness.stop();
	}
}, 30_000);

test("only the remembered browser can reconnect; one that is not remembered ends it", async () => {
	const harness = await startHarness();
	const target = { channelId: "web", conversationId: "c1" };

	try {
		const { link } = await harness.connect();
		const browser = await pair(harness, link, "c1", { remember: true });

		await until(() => browser.staticKeyPair !== undefined);
		await browser.reconnect({ as: generateKeyPair() });
		await until(
			() => browser.session?.kind === "reconnect",
			5000,
			"the stranger's handshake",
		);
		// Message 1 doesn't decrypt on the agent side, so no message 2 comes.
		await Bun.sleep(300);
		expect(browser.session?.state).toBe("handshake");
		expect(harness.gateway.pairing(target)).toMatchObject({
			state: "connected",
			away: true,
		});

		await browser.reconnect();
		await browser.confirmed;
		expect(harness.gateway.pairing(target)?.away).toBeUndefined();

		const { link: other } = await harness.connect("c2");
		const forgotten = await pair(harness, other, "c2");

		forgotten.close();
		await until(
			() =>
				harness.gateway.pairing({ channelId: "web", conversationId: "c2" }) ===
				undefined,
			5000,
			"the connection to end",
		);
	} finally {
		await harness.stop();
	}
}, 30_000);

test("kill disconnects the browser with an authenticated CLOSE", async () => {
	const harness = await startHarness();

	try {
		const { link, sessionId } = await harness.connect();
		const browser = await pair(harness, link);

		await harness.gateway.disconnect({ acpSessionId: sessionId });
		await until(() => browser.closeEvent !== undefined);
		expect(browser.closeEvent).toEqual({
			kind: "ended",
			reason: "Disconnected on the agent's machine.",
			byPeer: true,
		});
		expect(
			harness.gateway.pairing({ channelId: "web", conversationId: "c1" }),
		).toBeUndefined();
	} finally {
		await harness.stop();
	}
}, 30_000);

test("words the user does not confirm end the connection", async () => {
	const harness = await startHarness();

	try {
		const { link } = await harness.connect();
		const browser = await RelayBrowser.open(link, relay.url);
		const target = { channelId: "web", conversationId: "c1" };

		await until(() => harness.gateway.pairing(target)?.state === "verifying");
		await harness.gateway.confirmPairing(target, false);
		await until(() => browser.closeEvent !== undefined);
		expect(browser.closeEvent).toMatchObject({ kind: "ended", byPeer: true });
		await until(
			async () => (await harness.gateway.listConnections()).length === 0,
		);
	} finally {
		await harness.stop();
	}
}, 30_000);

test("revoke drops the channel's connections, and its links stop working", async () => {
	const harness = await startHarness();

	try {
		const { link: pending } = await harness.connect("c1");
		const { link: active } = await harness.connect("c2");
		const browser = await pair(harness, active, "c2");

		const dropped = await harness.gateway.revoke("web");
		expect(dropped.map((mapping) => mapping.conversationId).sort()).toEqual([
			"c1",
			"c2",
		]);
		await until(() => browser.closeEvent !== undefined);
		expect(browser.closeEvent).toMatchObject({ kind: "ended", byPeer: true });

		// The link that was never opened leads nowhere.
		const late = await RelayBrowser.open(pending, relay.url);
		await until(() => late.socketClosed !== undefined);
		expect(late.words).toBeUndefined();

		// The next link carries a new key.
		const { link: next } = await harness.connect("c3");
		expect(parseLink(next).staticPublicKey).not.toEqual(
			parseLink(pending).staticPublicKey,
		);
	} finally {
		await harness.stop();
	}
}, 30_000);
