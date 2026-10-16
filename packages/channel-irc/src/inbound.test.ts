import { expect, test } from "bun:test";
import {
	addressedText,
	isSenderAllowed,
	maskMatches,
	spoofableEntries,
} from "./inbound.ts";

const alice = { nick: "Alice", user: "~alice", host: "user/alice" };

test("an account entry needs the server to vouch for the account", () => {
	const policy = { mode: "allowlist" as const, allow: ["account:alice"] };

	expect(isSenderAllowed(policy, { ...alice, account: "Alice" }, "alice")).toBe(
		true,
	);
	// Same nick, not logged in: not let in.
	expect(isSenderAllowed(policy, alice, "alice")).toBe(false);
	expect(
		isSenderAllowed(
			policy,
			{ ...alice, nick: "mallory", account: "mallory" },
			"x",
		),
	).toBe(false);
});

test("hostmasks match with wildcards, case-insensitively", () => {
	const policy = { mode: "allowlist" as const, allow: ["*!*@user/alice"] };

	expect(isSenderAllowed(policy, alice, "alice")).toBe(true);
	expect(
		isSenderAllowed(policy, { ...alice, host: "USER/ALICE" }, "alice"),
	).toBe(true);
	expect(
		isSenderAllowed(policy, { ...alice, host: "user/alice.evil" }, "alice"),
	).toBe(false);
	expect(isSenderAllowed(policy, { nick: "Alice" }, "alice")).toBe(false);
	expect(maskMatches("a?c!*@*", "abc!x@y")).toBe(true);
	expect(maskMatches("a.c", "abc")).toBe(false);
});

test("a channel entry lets in whoever writes there; a nick entry anyone using it", () => {
	expect(
		isSenderAllowed(
			{ allow: ["#Team"] },
			{ nick: "x", user: "u", host: "h" },
			"#team",
		),
	).toBe(true);
	expect(
		isSenderAllowed(
			{ allow: ["#team"] },
			{ nick: "x", user: "u", host: "h" },
			"x",
		),
	).toBe(false);
	expect(isSenderAllowed({ allow: ["alice"] }, alice, "alice")).toBe(true);
	expect(
		spoofableEntries({ allow: ["alice", "account:bob", "*!*@h", "#c", "*"] }),
	).toEqual(["alice"]);
});

test("modes: closed lets nobody in, open everybody, the default is the allowlist", () => {
	expect(
		isSenderAllowed({ mode: "closed", allow: ["*"] }, alice, "alice"),
	).toBe(false);
	expect(isSenderAllowed({ mode: "open" }, alice, "alice")).toBe(true);
	expect(isSenderAllowed(undefined, alice, "alice")).toBe(false);
	expect(isSenderAllowed({ allow: ["*"] }, alice, "alice")).toBe(true);
});

test("a channel message is for the bot only when addressed to it", () => {
	const nicks = ["Bot", "bot_"];

	expect(addressedText("bot: run the tests", nicks)).toBe("run the tests");
	expect(addressedText("BOT, hi", nicks)).toBe("hi");
	expect(addressedText("@bot hi", nicks)).toBe("hi");
	expect(addressedText("bot_: hi", nicks)).toBe("hi");
	expect(addressedText("bot:", nicks)).toBe("");
	expect(addressedText("bot is broken", nicks)).toBeUndefined();
	expect(addressedText("robot: hi", nicks)).toBeUndefined();
	expect(addressedText("alice: hi", nicks)).toBeUndefined();
});
