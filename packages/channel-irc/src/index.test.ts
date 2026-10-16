import { expect, test } from "bun:test";
import { createConsoleLogger } from "@acpantenna/channel";
import { configProblems } from "./config.ts";
import { createIrcChannel, ircChannel } from "./index.ts";

test("the definition is named for people, with its secrets marked", () => {
	expect(ircChannel.type).toBe("irc");
	expect(ircChannel.name).toBe("IRC");
	expect(ircChannel.configSchema.properties.password?.secret).toBe(true);
	expect(ircChannel.configSchema.properties.serverPassword?.secret).toBe(true);
	expect(ircChannel.configSchema.required).toEqual(["server", "nick"]);
	expect(ircChannel.capabilities).toMatchObject({
		attachments: false,
		thoughts: false,
	});
});

test("missing or malformed fields are reported before anything connects", () => {
	expect(
		configProblems({
			server: "irc.libera.chat",
			nick: "mybot",
			password: "x",
			channels: ["#team", "#secret key"],
		}),
	).toEqual([]);
	expect(configProblems({ server: "irc://x", nick: "1bot" })).toEqual([
		"server must be a host name, like irc.libera.chat.",
		"nick must be an IRC nick: letters, digits and []\\`_^{|}-, not starting with a digit or -.",
	]);
	expect(
		configProblems({ server: "irc.example", nick: "bot", channels: ["team"] }),
	).toEqual(['channels: "team" is not “#name” or “#name key”.']);
	expect(
		configProblems({
			server: "irc.example",
			nick: "bot",
			tls: false,
			password: "x",
		}),
	).toEqual([
		"A password would be sent in the clear: turn tls on (or connect to a server on this machine).",
	]);
	expect(
		configProblems({
			server: "localhost",
			nick: "bot",
			tls: false,
			password: "x",
		}),
	).toEqual([]);
});

test("a channel that cannot start says why", async () => {
	const adapter = createIrcChannel({ type: "irc", nick: "bot" });

	await expect(
		adapter.start({
			channelId: "irc",
			config: {},
			logger: createConsoleLogger("test"),
			emit: () => undefined,
		}),
	).rejects.toThrow("IRC channel: server must be a host name");
	expect(await adapter.health?.()).toMatchObject({ state: "starting" });
	expect(
		await adapter.send({ conversationId: "#c", text: "hi" }),
	).toMatchObject({
		ok: false,
		retryAfterMs: 5000,
	});
});
