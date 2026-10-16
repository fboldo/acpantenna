import { describe, expect, test } from "bun:test";
import type {
	ChannelInboundEvent,
	ChannelLogger,
	ChannelOutboundMessage,
} from "@acpantenna/channel";
import type { IrcChannelConfig } from "./config.ts";
import { IrcRuntime } from "./runtime.ts";
import { createFakeClock } from "./testing/fake-clock.ts";
import { createFakeServer } from "./testing/fake-server.ts";

const quiet: ChannelLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

async function setup(overrides: Partial<IrcChannelConfig> = {}) {
	const clock = createFakeClock();
	const server = createFakeServer();
	const events: ChannelInboundEvent[] = [];
	const runtime = new IrcRuntime(
		{
			type: "irc",
			server: "irc.example",
			nick: "bot",
			channels: ["#team"],
			sendBurst: 100,
			permissions: {
				inbound: {
					mode: "allowlist",
					allow: ["account:alice", "*!*@trusted.example"],
				},
			},
			...overrides,
		},
		{
			channelId: "irc",
			config: {},
			logger: quiet,
			emit: (event) => {
				events.push(event);
			},
		},
		{ connect: server.connect, schedule: clock.schedule, now: clock.now },
	);
	const started = runtime.start();
	await clock.settle();
	const connection = server.last;

	connection.send(":srv CAP * LS :account-tag");
	connection.send(":srv CAP * ACK :account-tag");
	connection.send(":srv 001 bot :Welcome");
	await started;
	connection.written.length = 0;

	const said = () =>
		connection.written.filter(
			(line) => line.startsWith("PRIVMSG") || line.startsWith("NOTICE"),
		);
	const send = (message: ChannelOutboundMessage) => runtime.send(message);

	return { clock, connection, events, runtime, said, send };
}

const ALICE = "@account=alice :alice!~a@user/alice";

describe("inbound", () => {
	test("in a channel, only messages addressed to the bot are prompts", async () => {
		const { connection, events } = await setup();

		connection.send(
			`${ALICE} PRIVMSG #team :just chatting`,
			`${ALICE} PRIVMSG #Team :bot: run the tests`,
		);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			conversation: { id: "#team", type: "room" },
			sender: {
				id: "account:alice",
				displayName: "alice",
				trusted: true,
			},
			content: { text: "run the tests" },
		});
	});

	test("respond: always takes every message from an allowed sender", async () => {
		const { connection, events } = await setup({ respond: "always" });

		connection.send(`${ALICE} PRIVMSG #team :just chatting`);
		expect(events[0]?.content.text).toBe("just chatting");
	});

	test("a private message is a prompt in a conversation named for the nick", async () => {
		const { connection, events } = await setup();

		connection.send(":Carol!~c@trusted.example PRIVMSG bot :hello");
		expect(events[0]).toMatchObject({
			conversation: { id: "carol", type: "dm" },
			sender: { id: "Carol!~c@trusted.example" },
			content: { text: "hello" },
		});
	});

	test("someone not on the allowlist is ignored, whatever their nick", async () => {
		const { connection, events } = await setup();

		connection.send(
			// The nick, but not logged in to the account.
			":alice!~a@elsewhere PRIVMSG bot :hello",
			"@account=mallory :mallory!~m@evil PRIVMSG #team :bot: hello",
		);
		expect(events).toEqual([]);
	});
});

describe("outbound", () => {
	test("a reply is plain lines, cut to fit, the rest kept for “more”", async () => {
		const { connection, said, send } = await setup({ maxLines: 2 });

		expect(
			send({ conversationId: "#team", text: "**One**\n\nTwo\nThree\nFour" }),
		).toMatchObject({ ok: true });
		expect(said()).toEqual([
			"PRIVMSG #team :One",
			"PRIVMSG #team :Two",
			"NOTICE #team :… 2 more lines; say “bot: more” to see them.",
		]);

		connection.written.length = 0;
		connection.send(`${ALICE} PRIVMSG #team :bot: more`);
		expect(said()).toEqual(["PRIVMSG #team :Three", "PRIVMSG #team :Four"]);
	});

	test("a long line never makes a line over 512 bytes", async () => {
		const { said, send } = await setup({ maxLines: 0 });

		send({ conversationId: "#team", text: "ünïcödé ".repeat(200) });
		const lines = said();

		expect(lines.length).toBeGreaterThan(3);

		for (const line of lines) {
			// With the prefix the server adds, at its longest.
			const relayed = `:bot!~${"u".repeat(10)}@${"h".repeat(63)} ${line}\r\n`;
			expect(new TextEncoder().encode(relayed).length).toBeLessThanOrEqual(512);
		}
	});

	test("streamed chunks go out as lines", async () => {
		const { clock, said, send } = await setup({
			delivery: { mode: "streamChunks" },
		});

		send({ conversationId: "#team", origin: "turn", text: "Hello " });
		send({ conversationId: "#team", origin: "turn", text: "world\nand" });
		expect(said()).toEqual(["PRIVMSG #team :Hello world"]);
		await clock.advance(2_000);
		expect(said()).toEqual([
			"PRIVMSG #team :Hello world",
			"PRIVMSG #team :and",
		]);
	});

	test("nothing is sent before the connection is up", async () => {
		const { runtime } = await setup();
		await runtime.stop();

		expect(runtime.send({ conversationId: "#team", text: "hi" })).toMatchObject(
			{
				ok: false,
				retryAfterMs: 5000,
			},
		);
	});
});

describe("permissions", () => {
	const prompt: ChannelOutboundMessage = {
		id: "i1:prompt",
		conversationId: "#team",
		text: "🔒 Run `make`?",
		interaction: {
			id: "i1",
			kind: "permission",
			options: [
				{ id: "allow", label: "Allow once", kind: "allow" },
				{ id: "reject", label: "Reject", kind: "reject" },
			],
		},
	};

	test("are listed, and answered by number without addressing the bot", async () => {
		const { connection, events, said, send } = await setup();

		send(prompt);
		expect(said()).toEqual([
			"PRIVMSG #team :🔒 Run `make`?",
			"PRIVMSG #team :  1. Allow once",
			"PRIVMSG #team :  2. Reject",
			"PRIVMSG #team :Reply with a number, or yes / no.",
		]);

		connection.written.length = 0;
		connection.send(`${ALICE} PRIVMSG #team :2`);

		expect(events).toHaveLength(1);
		expect(events[0]?.interaction).toEqual({ id: "i1", optionId: "reject" });
		expect(said()).toEqual(["NOTICE #team :→ Reject (alice)"]);

		// Answered: a second "1" is just chat.
		connection.send(`${ALICE} PRIVMSG #team :1`);
		expect(events).toHaveLength(1);
	});

	test("are not answered by someone off the allowlist", async () => {
		const { connection, events, send } = await setup();

		send(prompt);
		connection.send("@account=mallory :mallory!~m@evil PRIVMSG #team :1");
		expect(events).toEqual([]);
	});

	test("expire with the gateway's timeout", async () => {
		const { clock, connection, events, send } = await setup({
			permissions: {
				inbound: { allow: ["account:alice"] },
				interactionTimeoutSeconds: 10,
			},
		});

		send(prompt);
		await clock.advance(11_000);
		connection.send(`${ALICE} PRIVMSG #team :bot: 1`);
		expect(events[0]?.interaction).toBeUndefined();
		expect(events[0]?.content.text).toBe("1");
	});
});

test("tool calls are notices, unless turned off", async () => {
	const shown = await setup();

	shown.send({
		conversationId: "#team",
		event: {
			type: "toolCall",
			update: false,
			toolCall: { id: "t", title: "Run tests", kind: "execute" },
		},
	});
	await shown.clock.advance(1_500);
	expect(shown.said()).toEqual(["NOTICE #team :💻 Run tests"]);

	const hidden = await setup({ showToolCalls: false });
	hidden.send({
		conversationId: "#team",
		event: {
			type: "toolCall",
			update: false,
			toolCall: { id: "t", title: "Run tests" },
		},
	});
	await hidden.clock.advance(1_500);
	expect(hidden.said()).toEqual([]);
});
