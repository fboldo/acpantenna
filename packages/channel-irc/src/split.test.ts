import { expect, test } from "bun:test";
import { byteLength, splitLine, textBudget } from "./split.ts";

test("the budget leaves room for the prefix the server adds", () => {
	const known = textBudget(
		{ nick: "bot", userHost: "~bot@host.example", userLen: 10, hostLen: 63 },
		"PRIVMSG",
		"#chan",
	);
	// ":bot!~bot@host.example PRIVMSG #chan :" and CRLF: 40 bytes.
	expect(known).toBe(512 - 40);

	const unknown = textBudget(
		{ nick: "bot", userLen: 10, hostLen: 63 },
		"PRIVMSG",
		"#chan",
	);
	expect(unknown).toBeLessThan(known);
	expect(unknown).toBe(
		512 - byteLength(":bot!~uuuuuuuuuu@ PRIVMSG #chan :\r\n") - 63,
	);
});

test("a short line is left alone", () => {
	expect(splitLine("hello", 100)).toEqual(["hello"]);
});

test("long lines are cut between words, within the byte limit", () => {
	const line = "the quick brown fox jumps over the lazy dog ".repeat(10).trim();
	const pieces = splitLine(line, 50);

	expect(pieces.every((piece) => byteLength(piece) <= 50)).toBe(true);
	expect(pieces.join(" ")).toBe(line);
	expect(
		pieces.every((piece) => !piece.startsWith(" ") && !piece.endsWith(" ")),
	).toBe(true);
});

test("multi-byte text is never cut inside a character", () => {
	const line = "é".repeat(40); // 80 bytes, no spaces
	const pieces = splitLine(line, 25);

	expect(pieces.every((piece) => byteLength(piece) <= 25)).toBe(true);
	expect(pieces.join("")).toBe(line);
	expect(pieces[0]).toBe("é".repeat(12));
});

test("an emoji with modifiers stays whole", () => {
	const family = "👨‍👩‍👧‍👦"; // 25 bytes, one grapheme
	const pieces = splitLine(`ab ${family}${family}`, 30);

	expect(pieces).toEqual(["ab", family, family]);
});

test("a word longer than a line is cut where the line ends", () => {
	const pieces = splitLine(`a ${"x".repeat(30)}`, 10);

	expect(pieces).toEqual(["a", "xxxxxxxxxx", "xxxxxxxxxx", "xxxxxxxxxx"]);
});
