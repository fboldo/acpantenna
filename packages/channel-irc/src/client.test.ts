import { describe, expect, test } from "bun:test";
import type { ChannelLogger } from "@acpantenna/channel";
import {
	IrcClient,
	type IrcClientOptions,
	type IrcClientState,
	type IrcIncoming,
} from "./client.ts";
import { IrcSetupError } from "./errors.ts";
import { createFakeClock } from "./testing/fake-clock.ts";
import { createFakeServer } from "./testing/fake-server.ts";

const quiet: ChannelLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function setup(overrides: Partial<IrcClientOptions> = {}) {
	const clock = createFakeClock();
	const server = createFakeServer();
	const messages: IrcIncoming[] = [];
	const states: Array<[IrcClientState, string | undefined]> = [];
	const client = new IrcClient(
		{
			host: "irc.example",
			port: 6697,
			tls: true,
			tlsVerify: true,
			nick: "bot",
			username: "bot",
			realname: "acpantenna",
			account: "bot",
			nickserv: false,
			channels: [{ name: "#team" }, { name: "#secret", key: "k3y" }],
			sendBurst: 4,
			sendIntervalMs: 1000,
			connect: server.connect,
			logger: quiet,
			schedule: clock.schedule,
			now: clock.now,
			random: () => 1,
			...overrides,
		},
		{
			message: (message) => messages.push(message),
			state: (state, message) => states.push([state, message]),
		},
	);

	return { clock, server, client, messages, states };
}

describe("registration", () => {
	test("negotiates capabilities, logs in with SASL, then joins", async () => {
		const { clock, server, client, states } = setup({ password: "hunter2" });
		const started = client.start();
		await clock.settle();
		const connection = server.last;

		expect(connection.options).toMatchObject({
			host: "irc.example",
			port: 6697,
			tls: true,
			tlsVerify: true,
		});
		expect(connection.written).toEqual([
			"CAP LS 302",
			"NICK bot",
			"USER bot 0 * acpantenna",
		]);

		connection.send(
			":srv CAP * LS * :multi-prefix sasl=PLAIN,EXTERNAL",
			":srv CAP * LS :account-tag account-notify extended-join",
		);
		expect(connection.sent("CAP REQ")).toEqual([
			"CAP REQ :account-tag account-notify extended-join sasl",
		]);

		connection.send(
			":srv CAP * ACK :account-tag account-notify extended-join sasl",
		);
		expect(connection.written.at(-1)).toBe("AUTHENTICATE PLAIN");

		connection.send("AUTHENTICATE +");
		expect(connection.written.at(-1)).toBe(
			`AUTHENTICATE ${Buffer.from("bot\0bot\0hunter2").toString("base64")}`,
		);

		connection.send(
			":srv 900 bot bot!bot@h bot :You are now logged in",
			":srv 903 bot :SASL ok",
		);
		expect(connection.written.at(-1)).toBe("CAP END");

		connection.send(
			":srv 001 bot :Welcome",
			":srv 005 bot CASEMAPPING=ascii WHOX :are supported",
		);
		await started;

		expect(client.ready).toBe(true);
		expect(states.at(-1)).toEqual(["ready", undefined]);
		expect(connection.sent("JOIN")).toEqual(["JOIN #team", "JOIN #secret k3y"]);
		expect(client.caseMapping).toBe("ascii");
	});

	test("a wrong password stops the channel instead of retrying", async () => {
		const { clock, server, client, states } = setup({ password: "nope" });
		const started = client.start();
		await clock.settle();
		const connection = server.last;

		connection.send(":srv CAP * LS :sasl");
		connection.send(":srv CAP * ACK :sasl", "AUTHENTICATE +");
		connection.send(":srv 904 bot :SASL authentication failed");

		await expect(started).rejects.toBeInstanceOf(IrcSetupError);
		expect(connection.closed).toBe(true);
		expect(states.at(-1)?.[0]).toBe("stopped");

		await clock.advance(600_000);
		expect(server.connections).toHaveLength(1);
	});

	test("a password with no SASL on the server is refused unless NickServ is wanted", async () => {
		const refused = setup({ password: "pw" });
		const started = refused.client.start();
		await refused.clock.settle();
		refused.server.last.send(":srv CAP * LS :multi-prefix");
		await expect(started).rejects.toThrow("does not offer SASL");

		const nickserv = setup({ password: "pw", nickserv: true });
		const ok = nickserv.client.start();
		await nickserv.clock.settle();
		const connection = nickserv.server.last;
		connection.send(":srv CAP * LS :multi-prefix");
		expect(connection.written.at(-1)).toBe("CAP END");
		connection.send(":srv 001 bot :Welcome");
		await ok;
		expect(connection.sent("PRIVMSG NickServ")).toEqual([
			"PRIVMSG NickServ :IDENTIFY bot pw",
		]);
	});

	test("a nick in use gets another, and is asked back later", async () => {
		const { clock, server, client } = setup();
		const started = client.start();
		await clock.settle();
		const connection = server.last;

		connection.send(":srv CAP * LS :");
		connection.send(":srv 433 * bot :Nickname is already in use");
		expect(connection.written.at(-1)).toBe("NICK bot_");
		connection.send(":srv 433 * bot_ :Nickname is already in use");
		expect(connection.written.at(-1)).toBe("NICK bot1000");

		connection.send(":srv 001 bot1000 :Welcome");
		await started;
		expect(client.nick).toBe("bot1000");
		expect(client.nicks).toEqual(["bot1000", "bot"]);

		await clock.advance(60_000);
		expect(connection.sent("NICK").at(-1)).toBe("NICK bot");
		connection.send(":bot1000!bot@h NICK :bot");
		expect(client.nick).toBe("bot");
	});
});

async function registered(overrides: Partial<IrcClientOptions> = {}) {
	const context = setup(overrides);
	const started = context.client.start();
	await context.clock.settle();
	const connection = context.server.last;

	connection.send(":srv CAP * LS :account-tag");
	connection.send(":srv CAP * ACK :account-tag");
	connection.send(":srv 001 bot :Welcome");
	await started;

	return { ...context, connection };
}

describe("a registered connection", () => {
	test("answers PING at once, even behind a backlog", async () => {
		const { client, connection } = await registered({ sendBurst: 1 });

		for (let index = 0; index < 5; index += 1) {
			client.privmsg("#team", `line ${index}`);
		}

		connection.send("PING :abc");
		expect(connection.written.at(-1)).toBe("PONG abc");
		expect(client.backlog).toBeGreaterThan(0);
	});

	test("pings a quiet server, and reconnects when it stays quiet", async () => {
		const { clock, server, connection, states } = await registered();

		await clock.advance(120_000);
		expect(connection.sent("PING")).toEqual(["PING acpantenna"]);

		await clock.advance(150_000);
		expect(connection.closed).toBe(true);
		expect(states.at(-1)?.[0]).toBe("degraded");

		await clock.advance(2_000);
		expect(server.connections).toHaveLength(2);
	});

	test("reconnects with growing waits when the server can't be reached", async () => {
		const { clock, server, connection } = await registered();

		server.refuseNext(3);
		connection.close(new Error("read ECONNRESET"));

		await clock.advance(2_000); // 1st retry: refused
		await clock.advance(4_000); // 2nd: refused
		await clock.advance(8_000); // 3rd: refused
		expect(server.connections).toHaveLength(1);
		await clock.advance(16_000); // 4th: connects
		expect(server.connections).toHaveLength(2);
	});

	test("hands on messages with the account the server vouches for", async () => {
		const { messages, connection } = await registered();

		connection.send(
			"@account=alice :alice!~a@user/alice PRIVMSG #team :bot: hi",
			":mallory!~m@evil PRIVMSG bot :\u0001ACTION waves\u0001",
			":mallory!~m@evil PRIVMSG bot :\u0001VERSION\u0001",
			":srv NOTICE * :*** Looking up your hostname",
		);

		expect(messages).toEqual([
			expect.objectContaining({
				command: "PRIVMSG",
				target: "#team",
				text: "bot: hi",
				account: "alice",
				action: false,
			}),
			expect.objectContaining({
				target: "bot",
				text: "waves",
				action: true,
				account: undefined,
			}),
		]);
	});

	test("without account-tag, account-notify and extended-join keep track", async () => {
		const context = setup();
		const started = context.client.start();
		await context.clock.settle();
		const connection = context.server.last;

		connection.send(":srv CAP * LS :account-notify extended-join");
		connection.send(":srv CAP * ACK :account-notify extended-join");
		connection.send(":srv 001 bot :Welcome");
		await started;

		connection.send(
			":alice!~a@h JOIN #team alice :Alice",
			":alice!~a@h PRIVMSG #team :one",
			":alice!~a@h ACCOUNT *",
			":alice!~a@h PRIVMSG #team :two",
			// A tag is not believed when the capability was not agreed.
			"@account=root :eve!~e@h PRIVMSG #team :three",
		);

		expect(context.messages.map((message) => message.account)).toEqual([
			"alice",
			undefined,
			undefined,
		]);
	});

	test("rejoins a channel it was kicked from", async () => {
		const { clock, connection } = await registered();

		connection.send(":bot!bot@h JOIN #secret", ":op!o@h KICK #secret bot :out");
		await clock.advance(15_000);
		expect(connection.sent("JOIN").at(-1)).toBe("JOIN #secret k3y");
	});
});
