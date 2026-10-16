import { type CaseMapping, casefold, isChannelName } from "./protocol.ts";

/** The inbound policy fields the channel reads (the gateway enforces them too). */
export interface InboundPolicy {
	mode?: "closed" | "allowlist" | "open";
	allow?: string[];
}

/** Who sent a message, as far as the server has said. */
export interface IrcSender {
	nick: string;
	user?: string;
	host?: string;
	/**
	 * The services account the sender is logged in to, from the server
	 * (`account-tag`, or tracked with `account-notify`). Undefined when the
	 * server has not said, or they are not logged in.
	 */
	account?: string;
}

export const ACCOUNT_PREFIX = "account:";

/**
 * Whether `sender` may talk to the bot in `conversationId`. The gateway
 * compares ids exactly; IRC needs masks and accounts, so the channel decides
 * here and marks the messages it lets through as trusted.
 *
 * An entry is:
 * - `account:name`: anyone logged in to that services account (the server
 *   vouches for it; the safe choice),
 * - `nick!user@host` with `*` and `?`: a hostmask (safe only as far as the
 *   host is: a cloak, or a host you control),
 * - `#channel`: anyone writing in that channel,
 * - a bare nick: anyone using it, which anyone can be on a network without
 *   services. Avoid it.
 * - `*`: everyone.
 */
export function isSenderAllowed(
	policy: InboundPolicy | undefined,
	sender: IrcSender,
	conversationId: string,
	server: { caseMapping?: CaseMapping; chanTypes?: string } = {},
): boolean {
	const mapping = server.caseMapping ?? "rfc1459";
	const chanTypes = server.chanTypes ?? "#&";
	const mode = policy?.mode ?? "allowlist";

	if (mode === "open") {
		return true;
	}

	if (mode === "closed") {
		return false;
	}

	const fold = (value: string) => casefold(value, mapping);
	const source = `${sender.nick}!${sender.user ?? "*"}@${sender.host ?? "*"}`;

	return (policy?.allow ?? []).some((raw) => {
		const entry = raw.trim();

		if (entry === "*") {
			return true;
		}

		if (entry.toLowerCase().startsWith(ACCOUNT_PREFIX)) {
			const account = entry.slice(ACCOUNT_PREFIX.length);
			return (
				sender.account !== undefined &&
				account !== "" &&
				fold(sender.account) === fold(account)
			);
		}

		if (isChannelName(entry, chanTypes)) {
			return (
				isChannelName(conversationId, chanTypes) &&
				fold(entry) === fold(conversationId)
			);
		}

		if (entry.includes("!") || entry.includes("@")) {
			// Without the user and host known, a mask that names them cannot match.
			if (sender.user === undefined || sender.host === undefined) {
				return false;
			}

			return maskMatches(fold(entry), fold(source));
		}

		return fold(entry) === fold(sender.nick);
	});
}

/** The allowlist entries that trust a bare nick, which anyone can take. */
export function spoofableEntries(policy: InboundPolicy | undefined): string[] {
	return (policy?.allow ?? []).filter((raw) => {
		const entry = raw.trim();
		return (
			entry !== "*" &&
			!entry.toLowerCase().startsWith(ACCOUNT_PREFIX) &&
			!isChannelName(entry) &&
			!entry.includes("!") &&
			!entry.includes("@")
		);
	});
}

/** A glob mask (`*` any run, `?` one character) against a whole string. */
export function maskMatches(mask: string, value: string): boolean {
	const pattern = mask
		.split("")
		.map((char) =>
			char === "*"
				? ".*"
				: char === "?"
					? "."
					: char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
		)
		.join("");

	return new RegExp(`^${pattern}$`, "s").test(value);
}

/**
 * The text of a channel message addressed to the bot (`nick: hi`,
 * `nick, hi`, `@nick hi`), without the address; undefined when it is not.
 */
export function addressedText(
	text: string,
	nicks: string[],
	mapping: CaseMapping = "rfc1459",
): string | undefined {
	const match = /^\s*@?([^\s:,]+)[:,]?(\s+|$)/.exec(text);

	if (!match?.[1]) {
		return undefined;
	}

	const said = casefold(match[1], mapping);
	const separated =
		/[:,]/.test(text.slice(0, match[0].length)) ||
		match[0].trimStart().startsWith("@");

	if (!separated || !nicks.some((nick) => casefold(nick, mapping) === said)) {
		return undefined;
	}

	return text.slice(match[0].length).trim();
}
