/**
 * The pairing link: `<web origin>/#v1.<room>.<s_pub>.<psk>.<expiry>`.
 *
 * `room` (16 bytes), `s_pub` (32) and `psk` (32) are base64url without
 * padding; `expiry` is unix seconds in decimal. Everything secret is in the
 * fragment, which browsers never send to a server.
 */

import {
	base64urlDecode,
	base64urlEncode,
	concatBytes,
	utf8Encode,
} from "./bytes.ts";

export const LINK_VERSION = "v1";
export const ROOM_LENGTH = 16;
export const KEY_LENGTH = 32;
/** How long a link is valid by default: 10 minutes. */
export const DEFAULT_LINK_TTL_SECONDS = 10 * 60;
/** The label at the start of the prologue. */
export const PROLOGUE_LABEL = "acpantenna-relay/1";

export interface PairingLink {
	/** The web client's origin, e.g. `https://app.example`. */
	webOrigin: string;
	room: Uint8Array;
	/** The agent side's static X25519 public key. */
	staticPublicKey: Uint8Array;
	psk: Uint8Array;
	/** Unix seconds. */
	expiry: number;
}

export class LinkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LinkError";
	}
}

/**
 * Checks that `origin` is an origin and nothing more — a scheme, a host and
 * maybe a port — and returns it in the form `URL.origin` gives.
 */
export function normalizeWebOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new LinkError(`Not a URL: ${origin}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new LinkError("The web origin is http or https");
	}
	if (
		url.origin !== origin.replace(/\/$/, "") ||
		url.username ||
		url.password
	) {
		throw new LinkError(
			`The web origin is a scheme and host only, like https://app.example: ${origin}`,
		);
	}
	return url.origin;
}

export function encodeLink(link: PairingLink): string {
	checkFields(link);
	const fragment = [
		LINK_VERSION,
		base64urlEncode(link.room),
		base64urlEncode(link.staticPublicKey),
		base64urlEncode(link.psk),
		String(link.expiry),
	].join(".");
	return `${normalizeWebOrigin(link.webOrigin)}/#${fragment}`;
}

/** Parses a link. It does not check expiry: see {@link isLinkExpired}. */
export function parseLink(text: string): PairingLink {
	const hashIndex = text.indexOf("#");
	if (hashIndex < 0) {
		throw new LinkError("The link has no fragment");
	}
	const base = text.slice(0, hashIndex).replace(/\/$/, "");
	const webOrigin = normalizeWebOrigin(base);
	const parts = text.slice(hashIndex + 1).split(".");
	if (parts.length !== 5 || parts[0] !== LINK_VERSION) {
		throw new LinkError("Not a v1 link");
	}
	const [, room, staticPublicKey, psk, expiry] = parts as [
		string,
		string,
		string,
		string,
		string,
	];
	if (!/^[1-9][0-9]{0,15}$/.test(expiry)) {
		throw new LinkError("Invalid expiry");
	}
	const link: PairingLink = {
		webOrigin,
		room: decodeField(room, "room"),
		staticPublicKey: decodeField(staticPublicKey, "static key"),
		psk: decodeField(psk, "psk"),
		expiry: Number(expiry),
	};
	checkFields(link);
	return link;
}

export function isLinkExpired(link: PairingLink, nowMs = Date.now()): boolean {
	return nowMs >= link.expiry * 1000;
}

/** The room id as it appears in the relay URL: base64url, 22 characters. */
export function roomId(room: Uint8Array): string {
	return base64urlEncode(room);
}

/**
 * The Noise prologue: `"acpantenna-relay/1" ‖ 0x00 ‖ room ‖ 0x00 ‖ web
 * origin`, binding the handshake to this room and this web client.
 */
export function prologue(room: Uint8Array, webOrigin: string): Uint8Array {
	if (room.length !== ROOM_LENGTH) {
		throw new LinkError("A room is 16 bytes");
	}
	return concatBytes(
		utf8Encode(PROLOGUE_LABEL),
		Uint8Array.of(0),
		room,
		Uint8Array.of(0),
		utf8Encode(normalizeWebOrigin(webOrigin)),
	);
}

function decodeField(text: string, name: string): Uint8Array {
	try {
		return base64urlDecode(text);
	} catch {
		throw new LinkError(`Invalid ${name}`);
	}
}

function checkFields(link: PairingLink): void {
	if (link.room.length !== ROOM_LENGTH) {
		throw new LinkError("A room is 16 bytes");
	}
	if (link.staticPublicKey.length !== KEY_LENGTH) {
		throw new LinkError("A static key is 32 bytes");
	}
	if (link.psk.length !== KEY_LENGTH) {
		throw new LinkError("A psk is 32 bytes");
	}
	if (!Number.isSafeInteger(link.expiry) || link.expiry <= 0) {
		throw new LinkError("Invalid expiry");
	}
}
