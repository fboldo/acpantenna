import { MAX_LINE_BYTES } from "./protocol.ts";

const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/** How the bot's own prefix may look to the people it writes to. */
export interface PrefixEstimate {
	nick: string;
	/** The `user@host` the server showed for the bot, when it has. */
	userHost?: string;
	/** Otherwise the longest the server says they can be (USERLEN, HOSTLEN). */
	userLen: number;
	hostLen: number;
}

/**
 * Bytes left for the text of one `PRIVMSG target :…` (or NOTICE) line. The
 * server relays the line with the bot's prefix in front, and cuts whatever
 * goes past 512 bytes then, so the prefix counts against the limit although
 * the bot never sends it. When the bot's host is not known yet, the longest
 * one the server allows is assumed (a `~` user included), so a line is
 * never cut in delivery.
 */
export function textBudget(
	prefix: PrefixEstimate,
	command: "PRIVMSG" | "NOTICE",
	target: string,
): number {
	const userHost =
		prefix.userHost ??
		`~${"u".repeat(prefix.userLen)}@${"h".repeat(prefix.hostLen)}`;
	const overhead = byteLength(
		`:${prefix.nick}!${userHost} ${command} ${target} :\r\n`,
	);

	return Math.max(64, MAX_LINE_BYTES - overhead);
}

/**
 * One line of text as pieces of at most `maxBytes` UTF-8 bytes each, cut
 * between words where it can, and never inside a character (or a grapheme,
 * such as an emoji with modifiers, unless that alone is too long).
 */
export function splitLine(line: string, maxBytes: number): string[] {
	if (byteLength(line) <= maxBytes) {
		return [line];
	}

	const pieces: string[] = [];
	let current = "";
	let currentBytes = 0;
	/** Where `current` last had a space: cut there rather than mid-word. */
	let lastSpace = -1;

	const push = (piece: string) => {
		const trimmed = piece.trimEnd();

		if (trimmed) {
			pieces.push(trimmed);
		}
	};

	for (const { segment } of graphemes.segment(line)) {
		const bytes = byteLength(segment);

		if (bytes > maxBytes) {
			// A single grapheme bigger than a line: cut it by code points.
			push(current);
			current = "";
			currentBytes = 0;
			lastSpace = -1;

			for (const piece of splitCodePoints(segment, maxBytes)) {
				pieces.push(piece);
			}

			continue;
		}

		if (currentBytes + bytes > maxBytes) {
			if (lastSpace > 0 && segment !== " ") {
				const head = current.slice(0, lastSpace);
				const tail = current.slice(lastSpace + 1);
				push(head);
				current = tail;
				currentBytes = byteLength(tail);
			} else {
				push(current);
				current = "";
				currentBytes = 0;
			}

			lastSpace = -1;

			// A word longer than a line is cut where the line ends.
			if (currentBytes + bytes > maxBytes) {
				push(current);
				current = "";
				currentBytes = 0;
			}

			if (segment === " " && current === "") {
				continue;
			}
		}

		if (segment === " ") {
			lastSpace = current.length;
		}

		current += segment;
		currentBytes += bytes;
	}

	push(current);
	return pieces;
}

function splitCodePoints(text: string, maxBytes: number): string[] {
	const pieces: string[] = [];
	let current = "";

	for (const char of text) {
		if (byteLength(current + char) > maxBytes) {
			pieces.push(current);
			current = "";
		}

		current += char;
	}

	if (current) {
		pieces.push(current);
	}

	return pieces;
}

/** Many lines, each split to fit. */
export function splitLines(lines: string[], maxBytes: number): string[] {
	return lines.flatMap((line) => splitLine(line, maxBytes));
}
