import { expect, test } from "bun:test";
import {
	conversationType,
	describeDiscordError,
	isSenderAllowed,
	mentionsBot,
	parentIds,
	stripBotMention,
} from "./inbound.ts";
import { DiscordApiError } from "./rest.ts";

const dm = { channelId: "900" };
const guildChannel = { channelId: "200", guildId: "100" };
const thread = { channelId: "300", guildId: "100", parentId: "200" };

test("the allowlist takes user, channel, thread parent and server IDs", () => {
	const allow = (ids: string[]) => ({ mode: "allowlist" as const, allow: ids });

	expect(isSenderAllowed(allow(["42"]), "42", dm)).toBe(true);
	expect(isSenderAllowed(allow(["42"]), "43", dm)).toBe(false);
	expect(isSenderAllowed(allow(["200"]), "43", guildChannel)).toBe(true);
	// Allowing a channel allows the threads started in it.
	expect(isSenderAllowed(allow(["200"]), "43", thread)).toBe(true);
	expect(isSenderAllowed(allow(["100"]), "43", thread)).toBe(true);
	expect(isSenderAllowed(allow(["100"]), "43", dm)).toBe(false);
	expect(isSenderAllowed(allow(["*"]), "43", dm)).toBe(true);
	expect(isSenderAllowed(undefined, "42", dm)).toBe(false);
	expect(isSenderAllowed({ mode: "open" }, "43", dm)).toBe(true);
	expect(isSenderAllowed({ mode: "closed", allow: ["42"] }, "42", dm)).toBe(
		false,
	);
	expect(parentIds(thread)).toEqual(["100", "200"]);
	expect(parentIds(dm)).toEqual([]);
});

test("a conversation is a DM, a group DM, a thread or a channel", () => {
	expect(conversationType(1, undefined)).toBe("dm");
	expect(conversationType(undefined, undefined)).toBe("dm");
	expect(conversationType(3, undefined)).toBe("group");
	expect(conversationType(11, "100")).toBe("thread");
	expect(conversationType(0, "100")).toBe("room");
	expect(conversationType(undefined, "100")).toBe("room");
});

test("the bot's mention is noticed and dropped from the prompt", () => {
	expect(mentionsBot("<@77> hi", undefined, "77")).toBe(true);
	expect(mentionsBot("<@!77> hi", undefined, "77")).toBe(true);
	expect(mentionsBot("hi", [{ id: "77" }], "77")).toBe(true);
	expect(mentionsBot("hi <@78>", [{ id: "78" }], "77")).toBe(false);
	expect(stripBotMention("<@77>, run the tests", "77")).toBe("run the tests");
	expect(stripBotMention("  <@!77> hi", "77")).toBe("hi");
	expect(stripBotMention("ask <@77> later", "77")).toBe("ask <@77> later");
});

test("errors read as reasons a person can act on", () => {
	expect(
		describeDiscordError(new DiscordApiError(401, 0, "401: Unauthorized")),
	).toBe(
		"Discord rejected the bot token. Reset it in the developer portal and update botToken.",
	);
	expect(
		describeDiscordError(
			new DiscordApiError(403, 50013, "Missing Permissions"),
		),
	).toContain("lacks a permission");
	expect(describeDiscordError(new TypeError("fetch failed"))).toBe(
		"Can't reach Discord; retrying.",
	);
	expect(describeDiscordError(new DiscordApiError(502, undefined, "x"))).toBe(
		"Discord is having trouble (HTTP 502); retrying.",
	);
});
