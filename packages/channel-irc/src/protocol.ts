/** One IRC protocol line, parsed (RFC 1459 framing with IRCv3 message tags). */
export interface IrcMessage {
	tags: Record<string, string>;
	/** `nick!user@host` or a server name; empty when the line has none. */
	prefix: string;
	/** Upper-cased: `PRIVMSG`, `001`, … */
	command: string;
	params: string[];
}

export interface IrcSource {
	nick: string;
	user?: string;
	host?: string;
}

/** The longest line a server takes, CRLF included (tags are counted apart). */
export const MAX_LINE_BYTES = 512;

const TAG_ESCAPES: Record<string, string> = {
	":": ";",
	s: " ",
	"\\": "\\",
	r: "\r",
	n: "\n",
};

/** A line as the server sent it, without its CRLF. Undefined when it is empty. */
export function parseLine(line: string): IrcMessage | undefined {
	let rest = line.replace(/[\r\n]+$/, "");
	const tags: Record<string, string> = {};
	let prefix = "";

	if (rest.startsWith("@")) {
		const end = rest.indexOf(" ");

		if (end === -1) {
			return undefined;
		}

		for (const pair of rest.slice(1, end).split(";")) {
			if (!pair) {
				continue;
			}

			const equals = pair.indexOf("=");
			const key = equals === -1 ? pair : pair.slice(0, equals);
			const value = equals === -1 ? "" : unescapeTag(pair.slice(equals + 1));
			tags[key] = value;
		}

		rest = rest.slice(end + 1).trimStart();
	}

	if (rest.startsWith(":")) {
		const end = rest.indexOf(" ");

		if (end === -1) {
			return undefined;
		}

		prefix = rest.slice(1, end);
		rest = rest.slice(end + 1).trimStart();
	}

	const params: string[] = [];
	let command = "";

	while (rest.length > 0) {
		if (command && rest.startsWith(":")) {
			params.push(rest.slice(1));
			break;
		}

		const end = rest.indexOf(" ");
		const word = end === -1 ? rest : rest.slice(0, end);

		if (command) {
			params.push(word);
		} else {
			command = word.toUpperCase();
		}

		rest = end === -1 ? "" : rest.slice(end + 1).trimStart();
	}

	return command ? { tags, prefix, command, params } : undefined;
}

function unescapeTag(value: string): string {
	return value.replace(/\\(.?)/g, (_, char: string) =>
		char === "" ? "" : (TAG_ESCAPES[char] ?? char),
	);
}

/** `nick!user@host` in its parts; a server name is all nick. */
export function parseSource(prefix: string): IrcSource {
	const bang = prefix.indexOf("!");
	const at = prefix.indexOf("@", bang === -1 ? 0 : bang);

	if (bang === -1 && at === -1) {
		return { nick: prefix };
	}

	if (bang === -1) {
		return { nick: prefix.slice(0, at), host: prefix.slice(at + 1) };
	}

	return {
		nick: prefix.slice(0, bang),
		user: at === -1 ? prefix.slice(bang + 1) : prefix.slice(bang + 1, at),
		...(at === -1 ? {} : { host: prefix.slice(at + 1) }),
	};
}

/**
 * A command line for the server, CRLF not included. Throws on CR, LF or NUL
 * anywhere, and on a space or leading colon in a middle parameter: whatever
 * reaches here from a message has already been split into lines, so either
 * would be a bug that lets text become a second command.
 */
export function formatLine(command: string, ...params: string[]): string {
	const parts = [command];

	params.forEach((param, index) => {
		if (/[\r\n\0]/.test(param)) {
			throw new Error(`IRC parameter contains a line break or NUL.`);
		}

		const last = index === params.length - 1;

		if (
			last &&
			(param === "" || param.includes(" ") || param.startsWith(":"))
		) {
			parts.push(`:${param}`);
			return;
		}

		if (param === "" || param.includes(" ") || param.startsWith(":")) {
			throw new Error(`IRC middle parameter "${param}" is not a word.`);
		}

		parts.push(param);
	});

	return parts.join(" ");
}

export function isChannelName(target: string, chanTypes = "#&"): boolean {
	return target.length > 1 && chanTypes.includes(target[0] ?? "");
}

export type CaseMapping = "ascii" | "rfc1459" | "strict-rfc1459";

/**
 * A nick or channel the way the server compares them. Under `rfc1459` (the
 * default) `[]\~` are the lower case of `{}|^`, so `Bot[1]` and `bot{1}` are
 * one nick.
 */
export function casefold(
	name: string,
	mapping: CaseMapping = "rfc1459",
): string {
	let folded = name.replace(/[A-Z]/g, (char) => char.toLowerCase());

	if (mapping === "ascii") {
		return folded;
	}

	folded = folded
		.replaceAll("[", "{")
		.replaceAll("]", "}")
		.replaceAll("\\", "|");

	return mapping === "rfc1459" ? folded.replaceAll("~", "^") : folded;
}

/** The server's ISUPPORT tokens (005) that matter here. */
export interface ServerFeatures {
	caseMapping: CaseMapping;
	chanTypes: string;
	nickLen: number;
	userLen: number;
	hostLen: number;
	whox: boolean;
}

export const DEFAULT_FEATURES: ServerFeatures = {
	caseMapping: "rfc1459",
	chanTypes: "#&",
	nickLen: 30,
	userLen: 10,
	hostLen: 63,
	whox: false,
};

/** Fold one 005 line's tokens (`CASEMAPPING=ascii NICKLEN=16 …`) into `features`. */
export function applyIsupport(
	features: ServerFeatures,
	tokens: string[],
): ServerFeatures {
	const next = { ...features };

	for (const token of tokens) {
		const [key = "", value = ""] = token.split("=", 2);
		const number = Number(value);

		switch (key.toUpperCase()) {
			case "CASEMAPPING":
				if (
					value === "ascii" ||
					value === "rfc1459" ||
					value === "strict-rfc1459"
				) {
					next.caseMapping = value;
				}
				break;
			case "CHANTYPES":
				next.chanTypes = value || next.chanTypes;
				break;
			case "NICKLEN":
				next.nickLen = number > 0 ? number : next.nickLen;
				break;
			case "USERLEN":
				next.userLen = number > 0 ? number : next.userLen;
				break;
			case "HOSTLEN":
				next.hostLen = number > 0 ? number : next.hostLen;
				break;
			case "WHOX":
				next.whox = true;
				break;
			default:
				break;
		}
	}

	return next;
}

/**
 * `CAP LS` tokens (`sasl=PLAIN,EXTERNAL account-tag`) as a map of capability
 * to its value ("" when it has none).
 */
export function parseCapList(list: string): Map<string, string> {
	const caps = new Map<string, string>();

	for (const token of list.split(" ")) {
		if (!token) {
			continue;
		}

		const equals = token.indexOf("=");
		const name = (equals === -1 ? token : token.slice(0, equals)).replace(
			/^[-~=]/,
			"",
		);

		caps.set(name, equals === -1 ? "" : token.slice(equals + 1));
	}

	return caps;
}

/**
 * The `AUTHENTICATE` lines for SASL PLAIN: base64 of
 * `authzid NUL authcid NUL password`, in 400-byte pieces, with a lone `+`
 * after a last piece of exactly 400.
 */
export function saslPlainLines(account: string, password: string): string[] {
	const payload = Buffer.from(`${account}\0${account}\0${password}`).toString(
		"base64",
	);
	const lines: string[] = [];

	for (let index = 0; index < payload.length; index += 400) {
		lines.push(payload.slice(index, index + 400));
	}

	if (lines.length === 0 || (lines.at(-1)?.length ?? 0) === 400) {
		lines.push("+");
	}

	return lines.map((piece) => formatLine("AUTHENTICATE", piece));
}

/** A PRIVMSG or NOTICE, its text always the trailing parameter. */
export function formatText(
	command: "PRIVMSG" | "NOTICE",
	target: string,
	text: string,
): string {
	// Checked as any line is; then written with the colon a one-word text
	// may go without, as clients do.
	formatLine(command, target, text);
	return `${command} ${target} :${text}`;
}
