import { describe, expect, test } from "bun:test";
import {
	addressedText,
	conversationOf,
	isSenderAllowed,
	parseConversationId,
} from "./inbound.ts";
import type { TelegramMessage } from "./types.ts";

const bot = { id: 999, username: "AgentBot" };
const me = { id: 42, is_bot: false, first_name: "Ada" };
const group = { id: -1001234, type: "supergroup" as const, title: "Team" };

function message(fields: Partial<TelegramMessage>): TelegramMessage {
	return {
		message_id: 10,
		date: 0,
		chat: { id: 42, type: "private" },
		from: me,
		...fields,
	};
}

describe("the allowlist", () => {
	test("numeric user ids, or chat ids, decide who can talk and tap", () => {
		const policy = { mode: "allowlist" as const, allow: ["42"] };

		expect(isSenderAllowed(policy, "42")).toBe(true);
		expect(isSenderAllowed(policy, "43")).toBe(false);
		expect(isSenderAllowed(undefined, "42")).toBe(false);
		expect(isSenderAllowed({ allow: ["-1001234"] }, "7", "-1001234")).toBe(
			true,
		);
		// A topic is a conversation of its own, as the gateway sees it too.
		expect(isSenderAllowed({ allow: ["-1001234"] }, "7", "-1001234:5")).toBe(
			false,
		);
		expect(isSenderAllowed({ mode: "open" }, "7")).toBe(true);
		expect(isSenderAllowed({ mode: "closed", allow: ["42"] }, "42")).toBe(
			false,
		);
		expect(isSenderAllowed({ allow: ["*"] }, "7")).toBe(true);
	});
});

describe("conversations", () => {
	test("a chat is its id; a forum topic is chat:topic", () => {
		expect(conversationOf(message({}))).toEqual({ id: "42", type: "dm" });
		expect(conversationOf(message({ chat: group }))).toEqual({
			id: "-1001234",
			type: "group",
		});
		expect(
			conversationOf(
				message({
					chat: { ...group, is_forum: true },
					is_topic_message: true,
					message_thread_id: 5,
				}),
			),
		).toEqual({ id: "-1001234:5", type: "thread" });
		// A reply thread in an ordinary group is not a topic.
		expect(
			conversationOf(message({ chat: group, message_thread_id: 3 })).id,
		).toBe("-1001234");
	});

	test("ids parse back into chat and topic", () => {
		expect(parseConversationId("42")).toEqual({ chatId: 42 });
		expect(parseConversationId("-1001234:5")).toEqual({
			chatId: -1001234,
			threadId: 5,
		});
		expect(parseConversationId("@channel")).toBeUndefined();
		expect(parseConversationId("!room:matrix.org")).toBeUndefined();
	});
});

describe("what is addressed to the bot", () => {
	test("everything in a private chat", () => {
		expect(addressedText(message({ text: "hi" }), bot, true)).toEqual({
			addressed: true,
			text: "hi",
		});
	});

	test("in a group, a mention, without the mention", () => {
		const text = "@agentbot, run the tests";

		expect(
			addressedText(
				message({
					chat: group,
					text,
					entities: [{ type: "mention", offset: 0, length: 9 }],
				}),
				bot,
				true,
			),
		).toEqual({ addressed: true, text: "run the tests" });
		expect(
			addressedText(message({ chat: group, text: "just chatting" }), bot, true)
				.addressed,
		).toBe(false);
		expect(
			addressedText(
				message({
					chat: group,
					text: "@someoneelse hi",
					entities: [{ type: "mention", offset: 0, length: 12 }],
				}),
				bot,
				true,
			).addressed,
		).toBe(false);
	});

	test("in a group, a reply to the bot", () => {
		expect(
			addressedText(
				message({
					chat: group,
					text: "yes",
					reply_to_message: message({
						message_id: 3,
						chat: group,
						from: { id: 999, is_bot: true, first_name: "Agent" },
					}),
				}),
				bot,
				true,
			),
		).toEqual({ addressed: true, text: "yes" });
	});

	test("in a forum topic, the topic's own start is not a reply to the bot", () => {
		expect(
			addressedText(
				message({
					chat: { ...group, is_forum: true },
					is_topic_message: true,
					message_thread_id: 3,
					text: "hello",
					reply_to_message: message({
						message_id: 3,
						from: { id: 999, is_bot: true, first_name: "Agent" },
					}),
				}),
				bot,
				true,
			).addressed,
		).toBe(false);
	});

	test("commands for this bot, as the gateway's own commands", () => {
		expect(
			addressedText(
				message({
					chat: group,
					text: "/cancel@AgentBot",
					entities: [{ type: "bot_command", offset: 0, length: 16 }],
				}),
				bot,
				true,
			),
		).toEqual({ addressed: true, text: "/cancel" });
		expect(
			addressedText(
				message({
					chat: group,
					text: "/new@OtherBot",
					entities: [{ type: "bot_command", offset: 0, length: 13 }],
				}),
				bot,
				false,
			).addressed,
		).toBe(false);
	});

	test("every group message, when mentions are not required", () => {
		expect(
			addressedText(message({ chat: group, text: "hi all" }), bot, false),
		).toEqual({ addressed: true, text: "hi all" });
	});
});
