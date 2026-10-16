/**
 * C0 controls and DEL, which IRC clients read as formatting (bold ^B, colour
 * ^C, …) or as CTCP (^A): an agent's text is sent as it reads, never as
 * markup or a CTCP request. Tabs are spaces.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function sanitize(text: string): string {
	return text.replaceAll("\t", "    ").replace(CONTROL, "");
}

/**
 * Markdown, one line at a time, as plain text an IRC client shows well:
 * code fences dropped (their lines kept as they are), headings and emphasis
 * without their markers, links as `label <url>`, blank lines gone (IRC has
 * no empty message). It keeps state between lines, for fences, so a reply
 * that streams in a line at a time reads the same as one sent whole.
 */
export class PlainTextFormatter {
	private inFence = false;

	/** The line as it is shown, or undefined when it shows as nothing. */
	public line(raw: string): string | undefined {
		const line = sanitize(raw.replace(/\r$/, ""));

		if (/^\s*(```|~~~)/.test(line)) {
			this.inFence = !this.inFence;
			return undefined;
		}

		if (this.inFence) {
			return line.trim() === "" ? undefined : line.trimEnd();
		}

		if (line.trim() === "") {
			return undefined;
		}

		// A thematic break as a short rule.
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			return "———";
		}

		const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		const body = heading ? (heading[1] ?? "") : line;

		return inline(body).trimEnd() || undefined;
	}
}

function inline(text: string): string {
	return (
		text
			// Images and links: the label, then the URL to open.
			.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) =>
				label ? `${label} <${url}>` : `<${url}>`,
			)
			.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) =>
				label === url ? `<${url}>` : `${label} <${url}>`,
			)
			// Bold and strike markers go; `code` keeps its backticks, which read
			// as code in any client.
			.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
			.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
			// Single-star emphasis, but not a list bullet or `a * b`.
			.replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
			.replace(/^(\s*)[*+]\s+/, "$1• ")
			.replace(
				/^(\s*)-\s+\[( |x|X)\]\s+/,
				(_, indent, mark) => `${indent}${mark === " " ? "☐" : "☑"} `,
			)
			.replace(/^(\s*)-\s+/, "$1• ")
			.replace(/^>\s?/, "│ ")
	);
}

/** A whole text, as the lines it shows as. */
export function toPlainLines(text: string): string[] {
	const formatter = new PlainTextFormatter();
	const lines: string[] = [];

	for (const raw of text.split("\n")) {
		const line = formatter.line(raw);

		if (line !== undefined) {
			lines.push(line);
		}
	}

	return lines;
}
