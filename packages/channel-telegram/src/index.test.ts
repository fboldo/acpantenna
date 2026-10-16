import { expect, test } from "bun:test";
import { createConsoleLogger } from "@acpantenna/channel";
import { configProblems } from "./config.ts";
import { createTelegramChannel, telegramChannel } from "./index.ts";

test("the definition is named for people, with its token marked secret", () => {
	expect(telegramChannel.type).toBe("telegram");
	expect(telegramChannel.name).toBe("Telegram");
	expect(telegramChannel.configSchema.properties.botToken?.secret).toBe(true);
	expect(telegramChannel.configSchema.required).toEqual(["botToken"]);
	expect(telegramChannel.capabilities).toMatchObject({
		buttons: true,
		attachments: true,
		toolCalls: true,
		thoughts: false,
	});
});

test("missing or malformed fields are reported before anything connects", () => {
	expect(configProblems({ botToken: "123456789:AAE-abc_def" })).toEqual([]);
	expect(configProblems({})).toEqual([
		"Set the bot's token (from @BotFather).",
	]);
	expect(configProblems({ botToken: "not a token" })).toEqual([
		"botToken does not look like a bot token; BotFather's look like 123456789:AAE….",
	]);
	expect(
		configProblems({ botToken: "1:a", apiUrl: "api.telegram.org" }),
	).toEqual(["apiUrl is not a URL: api.telegram.org"]);
	expect(configProblems({ botToken: "1:a", editIntervalMs: -1 })).toEqual([
		"editIntervalMs must be a number of milliseconds.",
	]);
});

test("a channel that cannot start says why", async () => {
	const adapter = createTelegramChannel({ type: "telegram" });

	await expect(
		adapter.start({
			channelId: "telegram",
			config: {},
			logger: createConsoleLogger("test"),
			emit: () => undefined,
		}),
	).rejects.toThrow("Telegram channel: Set the bot's token (from @BotFather).");
	expect(await adapter.health?.()).toMatchObject({ state: "starting" });
	expect(
		await adapter.send({ conversationId: "42", text: "hi" }),
	).toMatchObject({ ok: false, retryAfterMs: 5000 });
});
