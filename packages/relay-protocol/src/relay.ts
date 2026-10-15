/**
 * The relay's own messages: the text JSON around the opaque binary frames
 * (spec §1). A peer's first message is its hello; the relay answers with
 * status messages.
 */

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayRole = "agent" | "browser";

export interface RelayHello {
	v: 1;
	role: RelayRole;
	/** Agent only: an optional plan credential. */
	token?: string;
	/** Browser only: a remembered browser coming back to reconnect. */
	resume?: true;
}

export type RelayCloseReason =
	| "time-limit"
	| "ttl"
	| "replaced"
	| "limit"
	| "protocol";

export type RelayStatus =
	| { t: "waiting" }
	| { t: "ready" }
	| { t: "peer-left" }
	| { t: "closed"; reason: RelayCloseReason };

/** WebSocket close code for a second browser in a room. */
export const CLOSE_CODE_ROOM_FULL = 4009;

/** The largest binary message a relay forwards: one Noise message. */
export const MAX_RELAY_BINARY_LENGTH = 65535 + 16;

/** The path of a room on a relay: `/v1/rooms/<room>`. */
export function roomPath(room: string): string {
	return `/v1/rooms/${room}`;
}

/** Parses a status message from the relay, or returns undefined if it is not one. */
export function parseRelayStatus(text: string): RelayStatus | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const { t, reason } = value as { t?: unknown; reason?: unknown };
	if (t === "waiting" || t === "ready" || t === "peer-left") {
		return { t };
	}
	if (
		t === "closed" &&
		(reason === "time-limit" ||
			reason === "ttl" ||
			reason === "replaced" ||
			reason === "limit" ||
			reason === "protocol")
	) {
		return { t, reason };
	}
	return undefined;
}

/** Parses a peer's hello, or returns undefined if it is not one. */
export function parseRelayHello(text: string): RelayHello | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const { v, role, token, resume } = value as {
		v?: unknown;
		role?: unknown;
		token?: unknown;
		resume?: unknown;
	};
	if (v !== RELAY_PROTOCOL_VERSION) {
		return undefined;
	}
	if (role === "browser" && token === undefined) {
		if (resume === true) {
			return { v, role, resume };
		}
		return resume === undefined ? { v, role } : undefined;
	}
	if (
		role === "agent" &&
		resume === undefined &&
		(token === undefined || typeof token === "string")
	) {
		return token === undefined ? { v, role } : { v, role, token };
	}
	return undefined;
}
