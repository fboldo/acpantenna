import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWebhookChannel } from "@acpantenna/channel-webhook";
import { builtinChannels, describeChannels } from "./main.ts";

test("describes every registered channel type, with secrets marked", () => {
	const description = describeChannels([
		...builtinChannels,
		{
			type: "chat",
			name: "Chat",
			capabilities: { buttons: true, toolCalls: true },
			configSchema: {
				type: "object",
				properties: {
					token: { type: "string", title: "Bot token", secret: true },
					channelId: { type: "string" },
				},
				required: ["token"],
			},
			create: createWebhookChannel,
		},
	]);

	expect(description.version).toBe(1);
	expect(description.channels).toEqual([
		{
			type: "webhook",
			name: "Webhook",
			description: expect.any(String),
			capabilities: { inbound: true, outbound: true, routes: true },
			config: { type: "object", properties: {} },
		},
		expect.objectContaining({ type: "matrix", name: "Matrix" }),
		expect.objectContaining({
			type: "relay",
			capabilities: { acp: true },
			config: expect.objectContaining({ required: ["relayUrl", "webOrigin"] }),
		}),
		expect.objectContaining({
			type: "telegram",
			name: "Telegram",
			config: expect.objectContaining({ required: ["botToken"] }),
		}),
		{
			type: "chat",
			name: "Chat",
			capabilities: { buttons: true, toolCalls: true },
			config: {
				type: "object",
				properties: {
					token: { type: "string", title: "Bot token", secret: true },
					channelId: { type: "string" },
				},
				required: ["token"],
			},
		},
	]);
	expect(
		description.common.properties.permissions?.properties?.toolCalls,
	).toMatchObject({ enum: ["deny", "allowTrusted", "ask"], default: "deny" });
	expect(
		description.common.properties.session?.properties?.rehydrateOnStart
			?.default,
	).toBe(true);
});

test("`channels --json` prints the registry without needing a config", async () => {
	const child = Bun.spawn({
		cmd: ["bun", join(import.meta.dir, "main.ts"), "channels", "--json"],
		cwd: "/",
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(child.stdout).text();

	expect(await child.exited).toBe(0);
	expect(JSON.parse(output)).toEqual(describeChannels(builtinChannels));
});

test("the Matrix channel is built in, its token marked secret", () => {
	const matrix = describeChannels(builtinChannels).channels.find(
		(channel) => channel.type === "matrix",
	);

	expect(matrix?.capabilities).toMatchObject({
		buttons: true,
		toolCalls: true,
		thoughts: false,
	});
	expect(matrix?.config.required).toEqual(["homeserverUrl", "userId"]);
	expect(matrix?.config.properties.password?.secret).toBe(true);
	expect(matrix?.config.properties.homeserverUrl?.default).toBe(
		"https://matrix.org",
	);
	expect(matrix?.config.properties.accessToken?.secret).toBe(true);
	expect(matrix?.config.properties.storePassphrase?.secret).toBe(true);
	expect(matrix?.config.properties.userId?.secret).toBeUndefined();
});

test("the Telegram channel is built in, its token marked secret", () => {
	const telegram = describeChannels(builtinChannels).channels.find(
		(channel) => channel.type === "telegram",
	);

	expect(telegram?.capabilities).toMatchObject({
		buttons: true,
		attachments: true,
		toolCalls: true,
	});
	expect(telegram?.config.properties.botToken?.secret).toBe(true);
	expect(telegram?.config.properties.apiUrl?.secret).toBeUndefined();
});
