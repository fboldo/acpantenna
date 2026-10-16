import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChannelInboundEvent,
	createConsoleLogger,
} from "@acpantenna/channel";
import type { TelegramChannelConfig } from "./config.ts";
import { OffsetStore } from "./offset-store.ts";
import { TelegramRuntime } from "./runtime.ts";
import { createFakeBotApi, eventually } from "./testing/fake-bot-api.ts";
import type { TelegramMessage } from "./types.ts";

const ME = { id: 42, is_bot: false, first_name: "Ada" };
const STRANGER = { id: 7, is_bot: false, first_name: "Eve" };
const GROUP = { id: -100, type: "supergroup" as const };
const directories: string[] = [];
const runtimes: TelegramRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));

	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function startBot(
	options: {
		config?: Partial<TelegramChannelConfig>;
		api?: ReturnType<typeof createFakeBotApi>;
	} = {},
) {
	const api = options.api ?? createFakeBotApi();
	const stateDir = mkdtempSync(join(tmpdir(), "telegram-channel-"));
	const events: ChannelInboundEvent[] = [];
	directories.push(stateDir);

	const runtime = new TelegramRuntime(
		{
			type: "telegram",
			botToken: "123:abc",
			permissions: { inbound: { mode: "allowlist", allow: ["42"] } },
			...options.config,
		},
		{
			channelId: "telegram",
			config: {},
			stateDir,
			logger: createConsoleLogger("test"),
			emit: (event) => void events.push(event),
		},
		{ fetch: api.fetch, sleep: async () => undefined },
	);
	runtimes.push(runtime);
	await runtime.start();

	return { api, events, runtime, stateDir };
}

function message(fields: Partial<TelegramMessage>): TelegramMessage {
	return {
		message_id: 1,
		date: Math.floor(Date.now() / 1000),
		chat: { id: 42, type: "private" },
		from: ME,
		text: "hello",
		...fields,
	};
}

test("a message from someone on the allowlist reaches the gateway", async () => {
	const { api, events, runtime, stateDir } = await startBot();

	api.push({ message: message({ text: "run the tests" }) });
	await eventually(() => events.length === 1);

	expect(events[0]).toMatchObject({
		id: "42:1",
		type: "message",
		conversation: { id: "42", type: "dm" },
		sender: { id: "42", displayName: "Ada" },
		content: { text: "run the tests" },
	});
	await eventually(() => api.callsTo("sendChatAction").length === 1);
	expect(runtime.health().state).toBe("ready");
	// The update is confirmed, so a restart does not see it again.
	let offset: number | undefined;
	for (let attempt = 0; attempt < 100 && offset === undefined; attempt += 1) {
		offset = await new OffsetStore(stateDir).read();
		await Bun.sleep(5);
	}
	expect(offset).toBe(2);
});

test("someone not on it is told their id on /start, and nothing else", async () => {
	const { api, events } = await startBot();

	api.push({
		message: message({
			from: STRANGER,
			chat: { id: 7, type: "private" },
			text: "/start",
		}),
	});
	api.push({
		message: message({
			from: STRANGER,
			chat: { id: 7, type: "private" },
			text: "hi",
		}),
	});
	await eventually(() => api.callsTo("sendMessage").length === 1);
	await Bun.sleep(20);

	expect(events).toEqual([]);
	expect(api.callsTo("sendMessage")).toHaveLength(1);
	expect(api.callsTo("sendMessage")[0]?.params.text).toContain(
		"Your Telegram user id is 7",
	);
});

test("in a group, only what mentions or replies to the bot", async () => {
	const { api, events } = await startBot({
		config: {
			permissions: { inbound: { mode: "allowlist", allow: ["-100"] } },
		},
	});
	const group = { id: -100, type: "supergroup" as const };

	api.push({ message: message({ chat: group, text: "not for the bot" }) });
	api.push({
		message: message({
			message_id: 2,
			chat: group,
			from: STRANGER,
			text: "@AgentBot what's up",
			entities: [{ type: "mention", offset: 0, length: 9 }],
		}),
	});
	await eventually(() => events.length === 1);
	await Bun.sleep(20);

	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		conversation: { id: "-100", type: "group" },
		sender: { id: "7" },
		content: { text: "what's up" },
	});
});

test("replies go out as HTML, in the topic they belong to", async () => {
	const { api, runtime } = await startBot();

	expect(
		await runtime.send({ conversationId: "-100:5", text: "**done** <ok>" }),
	).toMatchObject({ ok: true, messageId: "100" });
	expect(api.callsTo("sendMessage")[0]?.params).toMatchObject({
		chat_id: -100,
		message_thread_id: 5,
		text: "<b>done</b> &lt;ok&gt;",
		parse_mode: "HTML",
	});
});

test("HTML Telegram cannot parse is sent again as plain text", async () => {
	const api = createFakeBotApi({
		answers: {
			sendMessage: (call) => {
				if (call.params.parse_mode) {
					throw {
						error_code: 400,
						description: "Bad Request: can't parse entities: unclosed tag",
					};
				}

				return { message_id: 5 };
			},
		},
	});
	const { runtime } = await startBot({ api });

	expect(await runtime.send({ conversationId: "42", text: "**x**" })).toEqual({
		ok: true,
		messageId: "5",
	});
	expect(api.callsTo("sendMessage").map((call) => call.params.text)).toEqual([
		"<b>x</b>",
		"**x**",
	]);
});

test("a long reply is split into messages of at most 4096", async () => {
	const { api, runtime } = await startBot();
	const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;

	await runtime.send({ conversationId: "42", text });

	expect(
		api.callsTo("sendMessage").map((call) => String(call.params.text).length),
	).toEqual([3000, 3000]);
});

test("a permission is answered with a button, by someone allowed, and the prompt shows the answer", async () => {
	const { api, events, runtime } = await startBot();

	await runtime.send({
		conversationId: "-100",
		text: "🔒 Run `ls`?",
		interaction: {
			id: "perm-1",
			kind: "permission",
			options: [
				{ id: "allow", label: "Allow", kind: "allow" },
				{ id: "deny", label: "Deny", kind: "reject" },
			],
		},
	});

	const prompt = api.callsTo("sendMessage")[0];
	const keyboard = prompt?.params.reply_markup as {
		inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
	};
	expect(keyboard.inline_keyboard[0]?.map((button) => button.text)).toEqual([
		"✅ Allow",
		"❌ Deny",
	]);

	// In the group, a tap from someone not on the allowlist does nothing but say so.
	api.push({
		callback_query: {
			id: "cb-0",
			from: STRANGER,
			message: message({ message_id: 100, chat: GROUP }),
			data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
		},
	});
	api.push({
		callback_query: {
			id: "cb-1",
			from: ME,
			message: message({ message_id: 100, chat: GROUP }),
			data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
		},
	});
	await eventually(() => events.length === 1);
	await eventually(() => api.callsTo("editMessageText").length === 1);

	expect(events[0]).toMatchObject({
		type: "reaction",
		conversation: { id: "-100" },
		sender: { id: "42" },
		interaction: { id: "perm-1", optionId: "allow" },
	});
	expect(api.callsTo("answerCallbackQuery").map((call) => call.params)).toEqual(
		[
			{ callback_query_id: "cb-0", text: "You can't answer this." },
			{ callback_query_id: "cb-1", text: "Allow" },
		],
	);
	const edit = api.callsTo("editMessageText")[0]?.params;
	expect(edit).toMatchObject({ chat_id: -100, message_id: 100 });
	expect(edit?.text).toBe("🔒 Run <code>ls</code>?\n\n→ <b>Allow</b> (Ada)");
	// No reply_markup: the buttons are gone.
	expect(edit?.reply_markup).toBeUndefined();

	// The same button again: the question is over.
	api.push({
		callback_query: {
			id: "cb-2",
			from: ME,
			message: message({ message_id: 100, chat: GROUP }),
			data: keyboard.inline_keyboard[0]?.[0]?.callback_data,
		},
	});
	await eventually(() => api.callsTo("answerCallbackQuery").length === 3);
	expect(api.callsTo("answerCallbackQuery")[2]?.params.text).toBe(
		"This question has expired.",
	);
});

test("a form is answered by replying to it", async () => {
	const { api, events, runtime } = await startBot();

	await runtime.send({
		conversationId: "42",
		text: "Which version?",
		interaction: {
			id: "form-1",
			kind: "elicitation",
			fields: [{ name: "version", type: "string", required: true }],
		},
	});
	api.push({
		message: message({
			text: "1.2.0",
			reply_to_message: message({
				message_id: 100,
				from: { id: 999, is_bot: true, first_name: "Agent" },
			}),
		}),
	});
	await eventually(() => events.length === 1);

	expect(events[0]?.interaction).toEqual({
		id: "form-1",
		content: { version: "1.2.0" },
	});
});

test("files go up as multipart; one over 50 MB becomes a notice", async () => {
	const { api, runtime } = await startBot();

	expect(
		await runtime.send({
			conversationId: "42",
			attachment: {
				name: "notes.txt",
				mimeType: "text/plain",
				size: 5,
				kind: "file",
				data: new TextEncoder().encode("hello"),
			},
		}),
	).toMatchObject({ ok: true });
	const upload = api.callsTo("sendDocument")[0];
	expect(upload?.params.chat_id).toBe("42");
	expect((upload?.form?.get("document") as File | undefined)?.name).toBe(
		"notes.txt",
	);

	await runtime.send({
		conversationId: "42",
		attachment: {
			name: "huge.mp4",
			mimeType: "video/mp4",
			size: 80 * 1024 * 1024,
			kind: "video",
			path: "/nonexistent/huge.mp4",
		},
	});
	expect(api.callsTo("sendVideo")).toEqual([]);
	expect(api.callsTo("sendMessage").at(-1)?.params.text).toBe(
		"⚠️ Could not send huge.mp4 (80 MB): Telegram bots can send files up to 50 MB.",
	);
});

test("a rejected token stops the channel with a reason", async () => {
	const api = createFakeBotApi({
		answers: {
			getMe: () => {
				throw { error_code: 401, description: "Unauthorized" };
			},
		},
	});

	await expect(startBot({ api })).rejects.toThrow(
		"Telegram rejected the bot token.",
	);
});

test("a bot with a webhook set is told to remove it", async () => {
	const api = createFakeBotApi({
		answers: { getWebhookInfo: () => ({ url: "https://example.com/hook" }) },
	});

	await expect(startBot({ api })).rejects.toThrow(
		"The bot has a webhook set (https://example.com/hook)",
	);
});

test("a send to something that is not a chat id is refused, not retried", async () => {
	const { runtime } = await startBot();

	expect(
		await runtime.send({ conversationId: "!room:matrix.org", text: "hi" }),
	).not.toHaveProperty("retryAfterMs");
});
