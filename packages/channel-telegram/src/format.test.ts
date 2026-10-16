import { describe, expect, test } from "bun:test";
import {
	cutMarkdown,
	markdownToHtml,
	openFence,
	splitMarkdown,
} from "./format.ts";

describe("markdown to Telegram HTML", () => {
	test("plain text is only escaped", () => {
		expect(markdownToHtml("hello there")).toBe("hello there");
		expect(markdownToHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
		expect(markdownToHtml("line one\nline two")).toBe("line one\nline two");
	});

	test("bold, italic, strike and inline code", () => {
		expect(
			markdownToHtml("**bold** and `code` and *it* and _it_ and ~~gone~~"),
		).toBe(
			"<b>bold</b> and <code>code</code> and <i>it</i> and <i>it</i> and <s>gone</s>",
		);
		expect(markdownToHtml("`a <b> & c`")).toBe(
			"<code>a &lt;b&gt; &amp; c</code>",
		);
		expect(markdownToHtml("`` a ` b ``")).toBe("<code>a ` b</code>");
	});

	test("what only looks like emphasis stays as written", () => {
		expect(markdownToHtml("snake_case_name and 2 * 3 * 4")).toBe(
			"snake_case_name and 2 * 3 * 4",
		);
		expect(markdownToHtml("\\*not italic\\*")).toBe("*not italic*");
		expect(markdownToHtml("**unclosed")).toBe("**unclosed");
	});

	test("crossed emphasis still comes out well nested", () => {
		expect(markdownToHtml("**a *b** c*")).toBe("<b>a *b</b> c*");
		expect(markdownToHtml("*a **b* c**")).toBe("<i>a **b</i> c**");
	});

	test("code blocks keep their language; an unclosed one runs to the end", () => {
		expect(markdownToHtml("```ts\nconst a = 1 < 2;\n```\nafter")).toBe(
			'<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>\nafter',
		);
		expect(markdownToHtml("```\nstill <streaming>")).toBe(
			"<pre>still &lt;streaming&gt;</pre>",
		);
		expect(markdownToHtml("```\n**not bold**\n```")).toBe(
			"<pre>**not bold**</pre>",
		);
	});

	test("headings, lists, quotes and task lists, in what Telegram can show", () => {
		expect(
			markdownToHtml(
				"# Title\n- one\n  - nested\n1. three\n> quoted **q**\n> more\n- [x] done\n- [ ] todo",
			),
		).toBe(
			"<b>Title</b>\n• one\n  • nested\n1. three\n<blockquote>quoted <b>q</b>\nmore</blockquote>\n☑ done\n☐ todo",
		);
	});

	test("raw HTML is shown as text, never passed through", () => {
		expect(markdownToHtml("<script>alert(1)</script> **hi**")).toBe(
			"&lt;script&gt;alert(1)&lt;/script&gt; <b>hi</b>",
		);
		expect(markdownToHtml('<a href="https://evil">x</a>')).toBe(
			'&lt;a href="https://evil"&gt;x&lt;/a&gt;',
		);
	});

	test("only safe link schemes become links, with their attributes escaped", () => {
		expect(
			markdownToHtml('[x](javascript:alert(1)) [y](https://e.com/?a="b"&c=1)'),
		).toBe('x <a href="https://e.com/?a=&quot;b&quot;&amp;c=1">y</a>');
		expect(markdownToHtml("[**docs**](https://e.com/(v2))")).toBe(
			'<a href="https://e.com/(v2)"><b>docs</b></a>',
		);
		expect(markdownToHtml("<https://example.com>")).toBe(
			'<a href="https://example.com">https://example.com</a>',
		);
		expect(markdownToHtml("![a chart](https://e.com/c.png)")).toBe(
			'<a href="https://e.com/c.png">a chart</a>',
		);
	});
});

describe("splitting at 4096", () => {
	test("short text is one part", () => {
		expect(splitMarkdown("hi")).toEqual(["hi"]);
		expect(splitMarkdown("")).toEqual([""]);
	});

	test("long text is cut at paragraphs, every part within the limit", () => {
		const paragraph = `${"word ".repeat(400).trim()}\n\n`;
		const parts = splitMarkdown(paragraph.repeat(6), 4096);

		expect(parts.length).toBeGreaterThan(1);
		expect(parts.every((part) => part.length <= 4096)).toBe(true);
		expect(parts.every((part) => part.startsWith("word"))).toBe(true);
		expect(parts.join(" ").split(/\s+/).filter(Boolean)).toHaveLength(2400);
	});

	test("a code block cut in two is closed and reopened with its language", () => {
		const code = `\`\`\`py\n${"x = 1\n".repeat(1000)}\`\`\`\nend`;
		const parts = splitMarkdown(code, 4096);

		expect(parts).toHaveLength(2);
		expect(parts[0]?.length).toBeLessThanOrEqual(4096);
		expect(parts[0]?.endsWith("\n```")).toBe(true);
		expect(parts[1]?.startsWith("```py\n")).toBe(true);
		expect(openFence(parts[0] ?? "")).toBeUndefined();
		expect(markdownToHtml(parts[1] ?? "")).toStartWith(
			'<pre><code class="language-py">x = 1',
		);
	});

	test("a line with no break at all is still cut, never inside a surrogate pair", () => {
		const [head, rest] = cutMarkdown("😀".repeat(3000), 4096);

		expect(head.length).toBeLessThanOrEqual(4096);
		expect(head + rest).toBe("😀".repeat(3000));
		expect(head.length % 2).toBe(0);
	});
});
