import { Marked, type Tokens } from "marked";

/** The `m.room.message` fields for a text: a plain body and, when it differs, HTML. */
export interface FormattedText {
	body: string;
	format?: "org.matrix.custom.html";
	formatted_body?: string;
}

const SAFE_LINK = /^(https?:|mailto:|matrix:)/i;

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Markdown to the HTML subset Matrix clients render. Safe by construction:
 * raw HTML in the text is escaped rather than passed through, links keep only
 * http(s), mailto and matrix URLs, and images (which Matrix only shows from
 * mxc:// URLs) become links.
 */
const markdown = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	renderer: {
		html({ text }: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }: Tokens.Link) {
			const label = this.parser.parseInline(tokens);

			if (!SAFE_LINK.test(href)) {
				return label;
			}

			const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(href)}"${titleAttribute}>${label}</a>`;
		},
		image({ href, text }: Tokens.Image) {
			const label = escapeHtml(text || href);

			return SAFE_LINK.test(href)
				? `<a href="${escapeHtml(href)}">${label}</a>`
				: label;
		},
		checkbox({ checked }: Tokens.Checkbox) {
			return checked ? "☑ " : "☐ ";
		},
	},
});

/**
 * Plain text stays as it is in `body`; HTML is added only when the markdown
 * renders to something richer than a paragraph of the same text.
 */
export function formatMarkdown(text: string): FormattedText {
	const html = (markdown.parse(text) as string).trim();
	const plain = `<p>${escapeHtml(text).replaceAll("\n", "<br>")}</p>`;

	if (html === plain || html === `<p>${escapeHtml(text)}</p>`) {
		return { body: text };
	}

	return {
		body: text,
		format: "org.matrix.custom.html",
		formatted_body: stripOuterParagraph(html),
	};
}

/** Already-safe HTML (built from escaped parts), with its plain fallback. */
export function formatHtml(body: string, html: string): FormattedText {
	return { body, format: "org.matrix.custom.html", formatted_body: html };
}

function stripOuterParagraph(html: string): string {
	if (
		html.startsWith("<p>") &&
		html.endsWith("</p>") &&
		html.indexOf("<p>", 1) === -1
	) {
		return html.slice(3, -4);
	}

	return html;
}
