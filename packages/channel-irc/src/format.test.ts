import { expect, test } from "bun:test";
import { PlainTextFormatter, sanitize, toPlainLines } from "./format.ts";

test("markdown reads as plain text", () => {
	expect(
		toPlainLines(
			[
				"## Plan",
				"",
				"I'll **fix** the _bug_ in `main.ts`, see [the docs](https://example.com).",
				"* one",
				"- two",
				"- [x] done",
				"> quoted",
				"---",
				"```ts",
				"const a = 1;",
				"",
				"  indented();",
				"```",
				"2 * 3 * 4",
			].join("\n"),
		),
	).toEqual([
		"Plan",
		"I'll fix the _bug_ in `main.ts`, see the docs <https://example.com>.",
		"• one",
		"• two",
		"☑ done",
		"│ quoted",
		"———",
		"const a = 1;",
		"  indented();",
		"2 * 3 * 4",
	]);
});

test("control characters never reach IRC as formatting or CTCP", () => {
	expect(
		sanitize("\u0001ACTION hi\u0001 \u0002bold\u0002 \u00034red\ttab"),
	).toBe("ACTION hi bold 4red    tab");
	expect(toPlainLines("a\r\nb")).toEqual(["a", "b"]);
});

test("a fence keeps its state across streamed lines", () => {
	const formatter = new PlainTextFormatter();

	expect(formatter.line("```")).toBeUndefined();
	expect(formatter.line("**not bold** in code")).toBe("**not bold** in code");
	expect(formatter.line("```")).toBeUndefined();
	expect(formatter.line("**bold**")).toBe("bold");
});
