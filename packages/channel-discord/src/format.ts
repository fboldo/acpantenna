/** Discord's limit on a message's `content`, in characters. */
export const MAX_MESSAGE_CHARS = 2000;

/**
 * No mention in what the bot sends pings anyone: an agent quoting
 * "@everyone" or a user ID should not notify a server.
 */
export const NO_MENTIONS = { parse: [] as string[] };

/**
 * Where to cut `text` so the first part fits in `limit`: at a paragraph,
 * else a line, else a space, in the second half of the window; else hard.
 */
function cutPoint(text: string, limit: number): number {
	const window = text.slice(0, limit);

	for (const separator of ["\n\n", "\n", " "]) {
		const at = window.lastIndexOf(separator);

		if (at > limit / 2) {
			return at;
		}
	}

	return limit;
}

/**
 * The code fence still open at the end of `text` (its opening line, like
 * "```ts"), or undefined when every fence is closed.
 */
export function openFence(text: string): string | undefined {
	let open: string | undefined;

	for (const line of text.split("\n")) {
		const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);

		if (!fence) {
			continue;
		}

		const marker = fence[1] ?? "";
		const info = fence[2]?.trim() ?? "";

		if (open === undefined) {
			open = `${marker}${info}`;
		} else if (
			info === "" &&
			marker[0] === open[0] &&
			marker.length >= fenceMarker(open).length
		) {
			open = undefined;
		}
	}

	return open;
}

function fenceMarker(fence: string): string {
	return /^(`+|~+)/.exec(fence)?.[0] ?? "```";
}

/**
 * The first message's worth of `text` and what is left, or undefined when
 * it fits. A code block cut in two is closed at the end of the first part
 * and opened again, with its language, at the start of the rest, so both
 * render as code.
 */
export function splitFirst(
	text: string,
	limit = MAX_MESSAGE_CHARS,
): [string, string] | undefined {
	if (text.length <= limit) {
		return undefined;
	}

	// Room for a closing fence, should the cut fall inside a code block.
	const room = limit - 8;
	let cut = cutPoint(text, room);
	const fence = openFence(text.slice(0, cut));

	if (fence) {
		// Inside code, keep whitespace as it is: cut at a line where there is one.
		const line = text.slice(0, room).lastIndexOf("\n");

		if (line > room / 2 && openFence(text.slice(0, line)) === fence) {
			cut = line;
		}

		const head = text.slice(0, cut).replace(/\n+$/, "");
		const rest = text.slice(cut).replace(/^\n/, "");
		return [`${head}\n${fenceMarker(fence)}`, `${fence}\n${rest}`];
	}

	return [text.slice(0, cut), text.slice(cut).replace(/^\s+/, "")];
}

/** `text` as messages of at most `limit` characters each. */
export function splitMessage(
	text: string,
	limit = MAX_MESSAGE_CHARS,
): string[] {
	const parts: string[] = [];
	let rest = text;

	for (;;) {
		const split = splitFirst(rest, limit);

		if (!split) {
			parts.push(rest);
			return parts;
		}

		parts.push(split[0]);
		rest = split[1];
	}
}

/** Text cut to `limit` characters with an ellipsis, for labels. */
export function truncate(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
