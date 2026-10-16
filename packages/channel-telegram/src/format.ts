/** Telegram counts a message's length after its HTML is parsed: the visible text. */
export const MAX_MESSAGE_CHARS = 4096;

const SAFE_LINK = /^(https?:|mailto:|tg:)/i;

/** Text for Telegram's HTML parse mode: only `&`, `<` and `>` are special there. */
export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
	return escapeHtml(text).replaceAll('"', "&quot;");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;

/**
 * The agent's markdown as Telegram HTML (`parse_mode: "HTML"`), which knows
 * only inline tags, `<pre>` and `<blockquote>`, and keeps newlines as they
 * are. Safe by construction: every piece of the text is escaped and the only
 * tags are the ones written here, always closed in order; links keep only
 * http(s), mailto and tg URLs. Headings become bold lines, list bullets •.
 * An unclosed code fence (a reply still streaming in) runs to the end.
 */
export function markdownToHtml(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const fence = FENCE.exec(line);

		if (fence) {
			const marker = fence[1] ?? "```";
			const language = fence[2] ?? "";
			const body: string[] = [];
			index += 1;

			while (index < lines.length && !closesFence(lines[index] ?? "", marker)) {
				body.push(lines[index] ?? "");
				index += 1;
			}

			index += 1;
			const code = escapeHtml(body.join("\n"));
			out.push(
				language
					? `<pre><code class="language-${escapeAttribute(language)}">${code}</code></pre>`
					: `<pre>${code}</pre>`,
			);
			continue;
		}

		if (/^ {0,3}>/.test(line)) {
			const quoted: string[] = [];

			while (index < lines.length && /^ {0,3}>/.test(lines[index] ?? "")) {
				quoted.push((lines[index] ?? "").replace(/^ {0,3}> ?/, ""));
				index += 1;
			}

			out.push(
				`<blockquote>${quoted.map(inlineToHtml).join("\n")}</blockquote>`,
			);
			continue;
		}

		out.push(blockLine(line));
		index += 1;
	}

	return out.join("\n");
}

function closesFence(line: string, marker: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.length >= marker.length &&
		trimmed[0] === marker[0] &&
		new RegExp(`^\\${marker[0]}{${marker.length},}$`).test(trimmed)
	);
}

function blockLine(line: string): string {
	const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);

	if (heading) {
		return `<b>${inlineToHtml(heading[1] ?? "")}</b>`;
	}

	if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
		return "———";
	}

	const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);

	if (task) {
		const box = task[2] === " " ? "☐" : "☑";
		return `${task[1]}${box} ${inlineToHtml(task[3] ?? "")}`;
	}

	const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);

	if (bullet) {
		return `${bullet[1]}• ${inlineToHtml(bullet[2] ?? "")}`;
	}

	return inlineToHtml(line);
}

type Delimiter = "**" | "__" | "~~" | "*" | "_";

const TAGS: Record<Delimiter, string> = {
	"**": "b",
	__: "b",
	"~~": "s",
	"*": "i",
	_: "i",
};

interface Frame {
	delimiter: Delimiter;
	html: string;
}

/**
 * One line's inline markdown: `code`, **bold**, *italic*, ~~strike~~,
 * [links](https://…). Emphasis is matched with a stack, so what is written
 * out is always well nested: a delimiter left unmatched is shown as itself.
 */
export function inlineToHtml(text: string): string {
	const root: Frame = { delimiter: "*", html: "" };
	const stack: Frame[] = [];
	const top = () => stack.at(-1) ?? root;
	let index = 0;

	const unwindTo = (depth: number) => {
		while (stack.length > depth) {
			const frame = stack.pop() as Frame;
			top().html += escapeHtml(frame.delimiter) + frame.html;
		}
	};

	while (index < text.length) {
		const char = text[index] ?? "";

		if (char === "\\" && /[\\`*_~[\]()#>!-]/.test(text[index + 1] ?? "")) {
			top().html += escapeHtml(text[index + 1] ?? "");
			index += 2;
			continue;
		}

		if (char === "`") {
			const run = /^`+/.exec(text.slice(index))?.[0] ?? "`";
			const close = findBacktickRun(text, index + run.length, run.length);

			if (close === -1) {
				top().html += escapeHtml(run);
				index += run.length;
				continue;
			}

			let code = text.slice(index + run.length, close);

			if (/^ .* $/.test(code)) {
				code = code.slice(1, -1);
			}

			top().html += `<code>${escapeHtml(code)}</code>`;
			index = close + run.length;
			continue;
		}

		if (char === "[" || (char === "!" && text[index + 1] === "[")) {
			const link =
				/^!?\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/.exec(
					text.slice(index),
				);

			if (link) {
				const [whole, label = "", href = ""] = link;
				const shown = inlineToHtml(label || href);

				top().html += SAFE_LINK.test(href)
					? `<a href="${escapeAttribute(href)}">${shown}</a>`
					: shown;
				index += whole.length;
				continue;
			}
		}

		if (char === "<") {
			const autolink = /^<((?:https?|mailto):[^\s>]+)>/i.exec(
				text.slice(index),
			);

			if (autolink) {
				const href = autolink[1] ?? "";
				top().html += `<a href="${escapeAttribute(href)}">${escapeHtml(href)}</a>`;
				index += autolink[0].length;
				continue;
			}
		}

		const delimiter = delimiterAt(text, index);

		if (delimiter) {
			const before = text[index - 1] ?? "";
			const after = text[index + delimiter.length] ?? "";
			const open = stack.findLastIndex(
				(frame) => frame.delimiter === delimiter,
			);
			const word = delimiter === "_" || delimiter === "__";
			const canClose =
				before !== "" && !/\s/.test(before) && !(word && isWordChar(after));
			const canOpen =
				after !== "" && !/\s/.test(after) && !(word && isWordChar(before));

			if (open !== -1 && canClose) {
				unwindTo(open + 1);
				const frame = stack.pop() as Frame;

				if (frame.html === "") {
					top().html += escapeHtml(delimiter + delimiter);
				} else {
					const tag = TAGS[delimiter];
					top().html += `<${tag}>${frame.html}</${tag}>`;
				}

				index += delimiter.length;
				continue;
			}

			if (canOpen) {
				stack.push({ delimiter, html: "" });
				index += delimiter.length;
				continue;
			}

			top().html += escapeHtml(delimiter);
			index += delimiter.length;
			continue;
		}

		top().html += escapeHtml(char);
		index += 1;
	}

	unwindTo(0);
	return root.html;
}

function delimiterAt(text: string, index: number): Delimiter | undefined {
	const two = text.slice(index, index + 2);

	if (two === "**" || two === "__" || two === "~~") {
		return two;
	}

	const one = text[index];
	return one === "*" || one === "_" ? one : undefined;
}

function isWordChar(char: string): boolean {
	return /[\p{L}\p{N}]/u.test(char);
}

function findBacktickRun(text: string, from: number, length: number): number {
	let at = text.indexOf("`".repeat(length), from);

	while (at !== -1) {
		const end = at + length;

		if (text[at - 1] !== "`" && text[end] !== "`") {
			return at;
		}

		let next = end;

		while (text[next] === "`") {
			next += 1;
		}

		at = text.indexOf("`".repeat(length), next);
	}

	return -1;
}

/** Room left for the fence that closes a code block cut in two. */
const FENCE_RESERVE = 64;

/**
 * Where to cut `text` so the first part fits in `limit`: at a paragraph, or
 * a line, in the second half of the window, or else at the limit itself
 * (never between the two halves of a surrogate pair).
 */
export function splitPoint(text: string, limit: number): number {
	const window = text.slice(0, limit);
	const paragraph = window.lastIndexOf("\n\n");

	if (paragraph > limit / 2) {
		return paragraph;
	}

	const line = window.lastIndexOf("\n");

	if (line > limit / 2) {
		return line;
	}

	const space = window.lastIndexOf(" ");

	if (space > limit * 0.8) {
		return space;
	}

	const code = text.charCodeAt(limit - 1);
	return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/**
 * The first message's worth of `text`, and the rest. A code block cut in
 * two is closed at the end of the first part and opened again, with its
 * language, at the start of the rest, so both still read as code.
 */
export function cutMarkdown(text: string, limit: number): [string, string] {
	if (text.length <= limit) {
		return [text, ""];
	}

	const cut = splitPoint(text, Math.max(1, limit - FENCE_RESERVE));
	let head = text.slice(0, cut);
	let rest = text.slice(cut).replace(/^\n+/, "");
	const fence = openFence(head);

	if (fence) {
		head = `${head.replace(/\n+$/, "")}\n${fence.marker}`;
		rest = `${fence.marker}${fence.language}\n${rest}`;
	}

	return [head, rest];
}

/** `text` in parts that each fit one message. */
export function splitMarkdown(
	text: string,
	limit = MAX_MESSAGE_CHARS,
): string[] {
	const parts: string[] = [];
	let rest = text;

	while (rest.length > limit) {
		const [head, tail] = cutMarkdown(rest, limit);
		parts.push(head);
		rest = tail;
	}

	if (rest !== "" || parts.length === 0) {
		parts.push(rest);
	}

	return parts;
}

/** The code fence still open at the end of `text`, if one is. */
export function openFence(
	text: string,
): { marker: string; language: string } | undefined {
	let open: { marker: string; language: string } | undefined;

	for (const line of text.split("\n")) {
		if (open) {
			if (closesFence(line, open.marker)) {
				open = undefined;
			}

			continue;
		}

		const fence = FENCE.exec(line);

		if (fence) {
			open = { marker: fence[1] ?? "```", language: fence[2] ?? "" };
		}
	}

	return open;
}
