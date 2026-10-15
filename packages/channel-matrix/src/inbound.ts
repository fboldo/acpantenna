/** The inbound policy fields the channel reads (the gateway enforces them too). */
export interface InboundPolicy {
	mode?: "closed" | "allowlist" | "open";
	allow?: string[];
}

/**
 * Whether `senderId` may talk to the bot in `roomId`, by the same rule the
 * gateway applies to messages: the channel also needs it for what never
 * reaches the gateway as a message (invites, reactions, verification).
 */
export function isSenderAllowed(
	policy: InboundPolicy | undefined,
	senderId: string,
	roomId?: string,
): boolean {
	const mode = policy?.mode ?? "allowlist";

	if (mode === "open") {
		return true;
	}

	if (mode === "closed") {
		return false;
	}

	const allow = policy?.allow ?? [];

	return (
		allow.includes("*") ||
		allow.includes(senderId) ||
		(roomId !== undefined && allow.includes(roomId))
	);
}

/**
 * The text of a message without the quoted fallback older clients put at the
 * top of a reply (`> <@user> original` lines, then a blank line).
 */
export function stripReplyFallback(body: string): string {
	const lines = body.split("\n");
	let index = 0;

	while (index < lines.length && lines[index]?.startsWith(">")) {
		index += 1;
	}

	if (index === 0) {
		return body;
	}

	if (lines[index] === "") {
		index += 1;
	}

	return lines.slice(index).join("\n");
}

/** A short, human-readable reason for a Matrix error, for logs and the settings page. */
export function describeMatrixError(
	error: unknown,
	homeserverUrl: string,
): string {
	const candidate = (error ?? {}) as {
		errcode?: string;
		httpStatus?: number;
		message?: string;
		name?: string;
		data?: { errcode?: string; error?: string };
	};
	const errcode = candidate.errcode ?? candidate.data?.errcode;
	const host = hostOf(homeserverUrl);

	switch (errcode) {
		case "M_UNKNOWN_TOKEN":
			return `The access token was rejected by ${host}. Create a new one for the bot and update the channel.`;
		case "M_MISSING_TOKEN":
			return "No access token is set for the bot.";
		case "M_FORBIDDEN":
			return `${host} refused the request: ${candidate.data?.error ?? "forbidden"}.`;
		case "M_LIMIT_EXCEEDED":
			return `${host} is rate-limiting the bot; retrying.`;
		case "M_USER_DEACTIVATED":
			return "The bot's Matrix account has been deactivated.";
		default:
			break;
	}

	if (errcode) {
		return `${host} answered ${errcode}: ${candidate.data?.error ?? candidate.message ?? "error"}.`;
	}

	const message = candidate.message ?? String(error);

	if (
		candidate.name === "ConnectionError" ||
		/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Unable to connect|network|socket/i.test(
			message,
		)
	) {
		return `Can't reach the homeserver at ${host}; retrying.`;
	}

	if (candidate.httpStatus && candidate.httpStatus >= 500) {
		return `${host} is having trouble (HTTP ${candidate.httpStatus}); retrying.`;
	}

	return message;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
