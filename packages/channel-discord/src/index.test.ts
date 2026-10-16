import { expect, test } from "bun:test";
import { createConsoleLogger } from "@acpantenna/channel";
import { configProblems, normalizeToken } from "./config.ts";
import { createDiscordChannel, discordChannel } from "./index.ts";

test("the definition is named for people, with its token marked secret", () => {
	expect(discordChannel.type).toBe("discord");
	expect(discordChannel.name).toBe("Discord");
	expect(discordChannel.configSchema.properties.botToken?.secret).toBe(true);
	expect(discordChannel.configSchema.required).toEqual(["botToken"]);
	expect(discordChannel.capabilities).toMatchObject({
		buttons: true,
		toolCalls: true,
		attachments: true,
		thoughts: false,
	});
});

test("missing or malformed fields are reported before anything connects", () => {
	expect(configProblems({ botToken: "MTIz.abc.def" })).toEqual([]);
	expect(configProblems({})).toEqual(["Set the bot's token (botToken)."]);
	expect(
		configProblems({
			botToken: "two words",
			editIntervalMs: -1,
			maxUploadBytes: 0,
		}),
	).toEqual([
		"botToken has spaces in it; paste the token alone.",
		"editIntervalMs must be a number of milliseconds, 0 or more.",
		"maxUploadBytes must be a number of bytes above 0.",
	]);
	// A token pasted with its header prefix is taken as the token.
	expect(normalizeToken(" Bot MTIz.abc.def ")).toBe("MTIz.abc.def");
	expect(configProblems({ botToken: "Bot MTIz.abc.def" })).toEqual([]);
});

test("a channel that cannot start says why", async () => {
	const adapter = createDiscordChannel({ type: "discord" });

	await expect(
		adapter.start({
			channelId: "discord",
			config: {},
			logger: createConsoleLogger("test"),
			emit: () => undefined,
		}),
	).rejects.toThrow("Discord channel: Set the bot's token (botToken).");
	expect(await adapter.health?.()).toMatchObject({ state: "starting" });
	expect(
		await adapter.send({ conversationId: "123", text: "hi" }),
	).toMatchObject({ ok: false, retryAfterMs: 5000 });
});
