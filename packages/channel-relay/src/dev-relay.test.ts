import { afterEach, describe, expect, test } from "bun:test";
import {
	CLOSE_CODE_ROOM_FULL,
	MAX_RELAY_BINARY_LENGTH,
	type RelayStatus,
} from "@acpantenna/relay-protocol";
import { type DevRelay, startDevRelay } from "./dev-relay.ts";

const ROOM = "AAECAwQFBgcICQoLDA0ODw";

interface Peer {
	socket: WebSocket;
	statuses: RelayStatus[];
	binary: Uint8Array[];
	closed?: { code: number; reason: string };
}

let relay: DevRelay | undefined;

afterEach(async () => {
	await relay?.stop();
	relay = undefined;
});

async function join(
	url: string,
	role: "agent" | "browser",
	room = ROOM,
	resume = false,
): Promise<Peer> {
	const socket = new WebSocket(`${url}/v1/rooms/${room}`);
	const peer: Peer = { socket, statuses: [], binary: [] };

	socket.binaryType = "arraybuffer";
	socket.addEventListener("message", (event) => {
		if (typeof event.data === "string") {
			peer.statuses.push(JSON.parse(event.data));
		} else {
			peer.binary.push(new Uint8Array(event.data as ArrayBuffer));
		}
	});
	socket.addEventListener("close", (event) => {
		peer.closed = { code: event.code, reason: event.reason };
	});
	await new Promise((resolve) => socket.addEventListener("open", resolve));
	socket.send(JSON.stringify({ v: 1, role, ...(resume ? { resume } : {}) }));
	return peer;
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out");
		}
		await Bun.sleep(10);
	}
}

describe("development relay", () => {
	test("pairs an agent and a browser, then forwards binary both ways", async () => {
		relay = startDevRelay();
		const agent = await join(relay.url, "agent");
		await until(() => agent.statuses.length === 1);
		expect(agent.statuses).toEqual([{ t: "waiting" }]);

		const browser = await join(relay.url, "browser");
		await until(
			() => browser.statuses.length === 1 && agent.statuses.length === 2,
		);
		expect(agent.statuses[1]).toEqual({ t: "ready" });
		expect(browser.statuses).toEqual([{ t: "ready" }]);

		browser.socket.send(Uint8Array.of(1, 2, 3));
		agent.socket.send(Uint8Array.of(4));
		await until(() => agent.binary.length === 1 && browser.binary.length === 1);
		expect(agent.binary[0]).toEqual(Uint8Array.of(1, 2, 3));
		expect(browser.binary[0]).toEqual(Uint8Array.of(4));

		browser.socket.close();
		await until(() => agent.statuses.length === 3);
		expect(agent.statuses[2]).toEqual({ t: "peer-left" });
	});

	test("a browser without an agent is told the room has expired", async () => {
		relay = startDevRelay();
		const browser = await join(relay.url, "browser");
		await until(() => browser.closed !== undefined);
		expect(browser.statuses).toEqual([{ t: "closed", reason: "ttl" }]);
	});

	test("a second browser is refused; a second agent replaces the first", async () => {
		relay = startDevRelay();
		const agent = await join(relay.url, "agent");
		await join(relay.url, "browser");
		const extra = await join(relay.url, "browser");
		await until(() => extra.closed !== undefined);
		expect(extra.closed?.code).toBe(CLOSE_CODE_ROOM_FULL);

		const replacement = await join(relay.url, "agent");
		await until(() => agent.closed !== undefined);
		expect(agent.statuses.at(-1)).toEqual({ t: "closed", reason: "replaced" });
		await until(() => replacement.statuses.length === 1);
		expect(replacement.statuses).toEqual([{ t: "ready" }]);
	});

	test("a remembered browser replaces its stale socket", async () => {
		relay = startDevRelay();
		const agent = await join(relay.url, "agent");
		const stale = await join(relay.url, "browser");
		await until(() => agent.statuses.length === 2);
		const back = await join(relay.url, "browser", ROOM, true);
		await until(() => stale.closed !== undefined);
		expect(stale.statuses.at(-1)).toEqual({ t: "closed", reason: "replaced" });
		await until(() => back.statuses.length === 1);
		expect(back.statuses).toEqual([{ t: "ready" }]);
		await until(() => agent.statuses.length === 4);
		expect(agent.statuses.slice(2)).toEqual([
			{ t: "peer-left" },
			{ t: "ready" },
		]);
	});

	test("a remembered browser waits for an agent that is away", async () => {
		relay = startDevRelay();
		const agent = await join(relay.url, "agent");
		const browser = await join(relay.url, "browser");
		await until(() => browser.statuses.length === 1);
		browser.socket.close();
		agent.socket.close();
		await until(() => agent.closed !== undefined);

		const back = await join(relay.url, "browser", ROOM, true);
		await until(() => back.statuses.length === 1);
		expect(back.statuses).toEqual([{ t: "waiting" }]);
		await join(relay.url, "agent");
		await until(() => back.statuses.length === 2);
		expect(back.statuses.at(-1)).toEqual({ t: "ready" });

		// A room that was never ready knows no browser to wait for.
		const stranger = await join(
			relay.url,
			"browser",
			"DDECAwQFBgcICQoLDA0ODw",
			true,
		);
		await until(() => stranger.closed !== undefined);
		expect(stranger.statuses).toEqual([{ t: "closed", reason: "ttl" }]);
	});

	test("text after the hello, or an oversized frame, closes the room", async () => {
		relay = startDevRelay();
		const agent = await join(relay.url, "agent");
		const browser = await join(relay.url, "browser");
		await until(() => browser.statuses.length === 1);
		browser.socket.send("hello again");
		await until(
			() => agent.closed !== undefined && browser.closed !== undefined,
		);
		expect(agent.statuses.at(-1)).toEqual({ t: "closed", reason: "protocol" });

		const agent2 = await join(relay.url, "agent", "BBECAwQFBgcICQoLDA0ODw");
		const browser2 = await join(relay.url, "browser", "BBECAwQFBgcICQoLDA0ODw");
		await until(() => browser2.statuses.length === 1);
		browser2.socket.send(new Uint8Array(MAX_RELAY_BINARY_LENGTH + 1));
		await until(() => agent2.closed !== undefined);
		expect(agent2.statuses.at(-1)).toEqual({ t: "closed", reason: "protocol" });
	});

	test("a room closes at its time limit, and an empty one at its TTL", async () => {
		relay = startDevRelay({ timeLimitMs: 100, roomTtlMs: 50 });
		const agent = await join(relay.url, "agent");
		await join(relay.url, "browser");
		await until(() => agent.closed !== undefined);
		expect(agent.statuses.at(-1)).toEqual({
			t: "closed",
			reason: "time-limit",
		});

		const lonely = await join(relay.url, "agent", "CCECAwQFBgcICQoLDA0ODw");
		await until(() => lonely.statuses.length === 1);
		lonely.socket.close();
		await until(() => relay?.rooms() === 0);
	});

	test("anything but a room path is not found", async () => {
		relay = startDevRelay();
		const response = await fetch(
			`${relay.url.replace("ws:", "http:")}/v1/rooms/short`,
		);
		expect(response.status).toBe(404);
	});
});
