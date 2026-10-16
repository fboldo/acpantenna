import { expect, test } from "bun:test";
import { openFence, splitMessage, truncate } from "./format.ts";

test("a message that fits is one part", () => {
	expect(splitMessage("hello")).toEqual(["hello"]);
	expect(splitMessage("x".repeat(2000))).toHaveLength(1);
});

test("a long message is cut at a paragraph, every part within the limit", () => {
	const paragraph = `${"word ".repeat(150).trim()}`;
	const text = Array.from({ length: 6 }, () => paragraph).join("\n\n");
	const parts = splitMessage(text);

	expect(parts.length).toBeGreaterThan(1);

	for (const part of parts) {
		expect(part.length).toBeLessThanOrEqual(2000);
		expect(part.startsWith("word")).toBe(true);
		expect(part.endsWith("word")).toBe(true);
	}

	expect(parts.join("\n\n")).toBe(text);
});

test("text with no break at all is cut hard", () => {
	const parts = splitMessage("x".repeat(4500));

	expect(parts.map((part) => part.length)).toEqual([1992, 1992, 516]);
});

test("a code block cut in two is closed and reopened with its language", () => {
	const code = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`);
	const text = `Here:\n\n\`\`\`ts\n${code.join("\n")}\n\`\`\`\n\nDone.`;
	const parts = splitMessage(text);

	expect(parts.length).toBeGreaterThan(1);

	for (const [index, part] of parts.entries()) {
		expect(part.length).toBeLessThanOrEqual(2000);
		expect(openFence(part)).toBeUndefined();

		if (index > 0) {
			expect(part.startsWith("```ts\n")).toBe(true);
		}
	}

	expect(parts.at(-1)?.endsWith("```\n\nDone.")).toBe(true);
	// No line of code is lost or cut.
	const lines = parts.join("\n").split("\n");
	for (const line of code) {
		expect(lines).toContain(line);
	}
});

test("open fences are found, closed ones are not", () => {
	expect(openFence("a\n```py\nx = 1")).toBe("```py");
	expect(openFence("```\nx\n```")).toBeUndefined();
	expect(openFence("````md\n```\ninner\n```\n")).toBe("````md");
	expect(openFence("~~~\nx")).toBe("~~~");
});

test("labels are cut with an ellipsis", () => {
	expect(truncate("short", 10)).toBe("short");
	expect(truncate("a  much\nlonger label", 10)).toBe("a much lo…");
});
