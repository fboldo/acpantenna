import { expect, test } from "bun:test";
import { formatMarkdown } from "./format.ts";

test("plain text stays plain", () => {
	expect(formatMarkdown("hello there")).toEqual({ body: "hello there" });
	expect(formatMarkdown("a & b < c")).toEqual({ body: "a & b < c" });
	expect(formatMarkdown("line one\nline two")).toEqual({
		body: "line one\nline two",
	});
});

test("markdown becomes HTML, with the markdown kept as the plain body", () => {
	expect(formatMarkdown("**bold** and `code`")).toEqual({
		body: "**bold** and `code`",
		format: "org.matrix.custom.html",
		formatted_body: "<strong>bold</strong> and <code>code</code>",
	});
	expect(formatMarkdown("```ts\nconst a = 1 < 2;\n```").formatted_body).toBe(
		'<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>',
	);
	expect(formatMarkdown("- one\n- two").formatted_body).toBe(
		"<ul>\n<li>one</li>\n<li>two</li>\n</ul>",
	);
});

test("raw HTML is shown as text, never passed through", () => {
	// An HTML block is escaped whole, markdown inside it included.
	expect(
		formatMarkdown("<script>alert(1)</script> **hi**").formatted_body,
	).toBe("&lt;script&gt;alert(1)&lt;/script&gt; **hi**");
	expect(formatMarkdown("**hi** <b>there</b>").formatted_body).toBe(
		"<strong>hi</strong> &lt;b&gt;there&lt;/b&gt;",
	);
	expect(formatMarkdown('<img src=x onerror="alert(1)">').formatted_body).toBe(
		"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
	);
});

test("only safe link schemes become links", () => {
	expect(
		formatMarkdown("[x](javascript:alert(1)) [y](https://example.com)")
			.formatted_body,
	).toBe('x <a href="https://example.com">y</a>');
	expect(formatMarkdown('[q](https://e.com/?a="b")').formatted_body).toBe(
		'<a href="https://e.com/?a=&quot;b&quot;">q</a>',
	);
});

test("images become links (Matrix only shows mxc:// images)", () => {
	expect(formatMarkdown("![a chart](https://e.com/c.png)").formatted_body).toBe(
		'<a href="https://e.com/c.png">a chart</a>',
	);
});
