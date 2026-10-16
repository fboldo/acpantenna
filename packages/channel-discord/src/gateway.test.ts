import { expect, test } from "bun:test";
import {
	DiscordGateway,
	type GatewayPayload,
	INTENTS,
	Op,
	type SocketHandlers,
} from "./gateway.ts";

interface FakeSocket {
	url: string;
	handlers: SocketHandlers;
	sent: GatewayPayload[];
	closed?: number;
	receive(payload: GatewayPayload): void;
}

function setup() {
	const sockets: FakeSocket[] = [];
	const timers: Array<{ callback: () => void; ms: number; live: boolean }> = [];
	const statuses: string[] = [];
	const events: string[] = [];
	const gateway = new DiscordGateway({
		token: "tok",
		gatewayUrl: async () => "wss://gateway.test",
		onDispatch: (type) => events.push(type),
		onStatus: (state, message) =>
			statuses.push(message ? `${state}: ${message}` : state),
		random: () => 0.5,
		schedule: (callback, ms) => {
			const timer = { callback, ms, live: true };
			timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
		createSocket: (url, handlers) => {
			const socket: FakeSocket = {
				url,
				handlers,
				sent: [],
				receive: (payload) => handlers.message(JSON.stringify(payload)),
			};
			sockets.push(socket);
			return {
				send: (data) => socket.sent.push(JSON.parse(data) as GatewayPayload),
				close: (code) => {
					socket.closed = code;
				},
			};
		},
	});

	/** Run the live timers due first (a heartbeat or a reconnect). */
	const fire = async (ms?: number) => {
		const due = timers.filter(
			(timer) => timer.live && (ms === undefined || timer.ms === ms),
		);

		for (const timer of due) {
			timer.live = false;
			timer.callback();
		}

		await Bun.sleep(0);
	};

	return { gateway, sockets, timers, statuses, events, fire };
}

const hello = { op: Op.Hello, d: { heartbeat_interval: 40_000 } };
const ready = {
	op: Op.Dispatch,
	t: "READY",
	s: 1,
	d: {
		session_id: "sess",
		resume_gateway_url: "wss://resume.test",
		user: { id: "77" },
	},
};

test("hello is answered with identify, the right intents and a heartbeat", async () => {
	const { gateway, sockets, timers, statuses, events, fire } = setup();

	await gateway.connect();
	const socket = sockets[0] as FakeSocket;
	expect(socket.url).toBe("wss://gateway.test/?v=10&encoding=json");

	socket.receive(hello);
	expect(socket.sent[0]).toMatchObject({
		op: Op.Identify,
		d: { token: "tok", intents: INTENTS },
	});
	// GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT.
	expect(INTENTS).toBe(1 + 512 + 4096 + 32768);
	// The first beat is jittered into the interval.
	expect(timers.at(-1)?.ms).toBe(20_000);

	socket.receive(ready);
	expect(statuses).toEqual(["ready"]);
	expect(events).toEqual(["READY"]);

	await fire(20_000);
	expect(socket.sent.at(-1)).toEqual({ op: Op.Heartbeat, d: 1 });
	expect(timers.at(-1)?.ms).toBe(40_000);
});

test("an unanswered heartbeat drops the connection and resumes the session", async () => {
	const { gateway, sockets, statuses, fire } = setup();

	await gateway.connect();
	const first = sockets[0] as FakeSocket;
	first.receive(hello);
	first.receive(ready);
	first.receive({ op: Op.Dispatch, t: "MESSAGE_CREATE", s: 5, d: {} });

	await fire(20_000); // beat, not answered
	await fire(40_000); // no ack: zombie
	expect(first.closed).toBe(4000);
	expect(statuses.at(-1)).toContain("stopped answering heartbeats");

	await fire(0); // reconnect
	const second = sockets[1] as FakeSocket;
	expect(second.url).toBe("wss://resume.test/?v=10&encoding=json");
	second.receive(hello);
	expect(second.sent[0]).toEqual({
		op: Op.Resume,
		d: { token: "tok", session_id: "sess", seq: 5 },
	});

	// Anything the old socket still says is ignored.
	first.handlers.close(1006, "");
	expect(statuses.at(-1)).toContain("stopped answering heartbeats");
});

test("Discord asking for a reconnect resumes; an invalid session identifies afresh", async () => {
	const { gateway, sockets, fire } = setup();

	await gateway.connect();
	(sockets[0] as FakeSocket).receive(hello);
	(sockets[0] as FakeSocket).receive(ready);
	(sockets[0] as FakeSocket).receive({ op: Op.Reconnect });
	await fire(0);

	const second = sockets[1] as FakeSocket;
	second.receive(hello);
	expect(second.sent[0]?.op).toBe(Op.Resume);

	second.receive({ op: Op.InvalidSession, d: false });
	expect(second.closed).toBe(1000);
	await fire(3_000);

	const third = sockets[2] as FakeSocket;
	expect(third.url).toBe("wss://gateway.test/?v=10&encoding=json");
	third.receive(hello);
	expect(third.sent[0]?.op).toBe(Op.Identify);
});

test("a dropped socket reconnects with backoff; a refused intent stops for good", async () => {
	const { gateway, sockets, timers, statuses, fire } = setup();

	await gateway.connect();
	(sockets[0] as FakeSocket).receive(hello);
	(sockets[0] as FakeSocket).handlers.close(1006, "");
	expect(statuses.at(-1)).toBe(
		"degraded: Lost the connection to Discord (1006); reconnecting.",
	);
	expect(timers.at(-1)?.ms).toBe(1_000);

	await fire(1_000);
	(sockets[1] as FakeSocket).handlers.close(4014, "Disallowed intent(s).");
	expect(statuses.at(-1)).toContain("turn on Message Content Intent");
	expect(statuses.at(-1)?.startsWith("stopped")).toBe(true);
	expect(timers.filter((timer) => timer.live && timer.ms !== 20_000)).toEqual(
		[],
	);
});

test("stop closes the session so the bot goes offline at once", async () => {
	const { gateway, sockets } = setup();

	await gateway.connect();
	gateway.stop();
	expect((sockets[0] as FakeSocket).closed).toBe(1000);
});
