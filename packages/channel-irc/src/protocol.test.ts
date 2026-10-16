import { expect, test } from "bun:test";
import {
	applyIsupport,
	casefold,
	DEFAULT_FEATURES,
	formatLine,
	formatText,
	parseCapList,
	parseLine,
	parseSource,
	saslPlainLines,
} from "./protocol.ts";

test("a line is read into tags, prefix, command and params", () => {
	expect(
		parseLine(
			"@account=alice;msgid=abc\\:1\\sx;+draft/reply :alice!~a@host.example PRIVMSG #chan :hello there: you\r\n",
		),
	).toEqual({
		tags: { account: "alice", msgid: "abc;1 x", "+draft/reply": "" },
		prefix: "alice!~a@host.example",
		command: "PRIVMSG",
		params: ["#chan", "hello there: you"],
	});
	expect(parseLine("PING :irc.example")).toEqual({
		tags: {},
		prefix: "",
		command: "PING",
		params: ["irc.example"],
	});
	expect(
		parseLine(":srv 005 bot CASEMAPPING=ascii NICKLEN=16 :are supported")
			?.params,
	).toEqual(["bot", "CASEMAPPING=ascii", "NICKLEN=16", "are supported"]);
	expect(parseLine("")).toBeUndefined();
});

test("a source is split into nick, user and host", () => {
	expect(parseSource("alice!~a@host")).toEqual({
		nick: "alice",
		user: "~a",
		host: "host",
	});
	expect(parseSource("irc.example")).toEqual({ nick: "irc.example" });
});

test("a line for the server cannot carry a second command", () => {
	expect(formatLine("PRIVMSG", "#chan", "hi there")).toBe(
		"PRIVMSG #chan :hi there",
	);
	expect(formatLine("JOIN", "#chan", "key")).toBe("JOIN #chan key");
	expect(formatLine("PRIVMSG", "#c", ":)")).toBe("PRIVMSG #c ::)");
	expect(() => formatLine("PRIVMSG", "#c", "hi\r\nQUIT")).toThrow();
	expect(() => formatLine("PRIVMSG", "#a b", "hi")).toThrow();
});

test("nicks compare under the server's case mapping", () => {
	expect(casefold("Bot[1]~")).toBe("bot{1}^");
	expect(casefold("Bot[1]~", "strict-rfc1459")).toBe("bot{1}~");
	expect(casefold("Bot[1]", "ascii")).toBe("bot[1]");
});

test("ISUPPORT and CAP LS are read", () => {
	expect(
		applyIsupport(DEFAULT_FEATURES, [
			"CASEMAPPING=ascii",
			"NICKLEN=16",
			"WHOX",
			"CHANTYPES=#",
		]),
	).toMatchObject({
		caseMapping: "ascii",
		nickLen: 16,
		whox: true,
		chanTypes: "#",
	});
	expect([
		...parseCapList("sasl=PLAIN,EXTERNAL account-tag multi-prefix"),
	]).toEqual([
		["sasl", "PLAIN,EXTERNAL"],
		["account-tag", ""],
		["multi-prefix", ""],
	]);
});

test("SASL PLAIN is base64 in 400-byte pieces", () => {
	expect(saslPlainLines("bot", "hunter2")).toEqual([
		`AUTHENTICATE ${Buffer.from("bot\0bot\0hunter2").toString("base64")}`,
	]);

	// 300 bytes is 400 base64 characters exactly: a lone + ends it.
	const lines = saslPlainLines("bot", "x".repeat(292));
	expect(lines).toHaveLength(2);
	expect(lines[0]).toHaveLength("AUTHENTICATE ".length + 400);
	expect(lines[1]).toBe("AUTHENTICATE +");
});

test("message text is always the trailing parameter", () => {
	expect(formatText("PRIVMSG", "#c", "hi")).toBe("PRIVMSG #c :hi");
	expect(() => formatText("NOTICE", "#c", "a\nb")).toThrow();
});
