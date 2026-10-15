/**
 * Byte helpers on plain `Uint8Array`s, so the package runs in a browser as
 * well as in Bun.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) {
		length += part.length;
	}
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Compares two byte strings without stopping at the first difference. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let index = 0; index < a.length; index++) {
		diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return diff === 0;
}

export function utf8Encode(text: string): Uint8Array {
	return encoder.encode(text);
}

/** Decodes UTF-8, throwing on invalid sequences rather than replacing them. */
export function utf8Decode(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
		throw new Error("Invalid hex string");
	}
	const out = new Uint8Array(hex.length / 2);
	for (let index = 0; index < out.length; index++) {
		out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return out;
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

const BASE64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding (RFC 4648 §5). */
export function base64urlEncode(bytes: Uint8Array): string {
	let out = "";
	let index = 0;
	for (; index + 2 < bytes.length; index += 3) {
		const n =
			((bytes[index] ?? 0) << 16) |
			((bytes[index + 1] ?? 0) << 8) |
			(bytes[index + 2] ?? 0);
		out +=
			BASE64URL.charAt((n >> 18) & 63) +
			BASE64URL.charAt((n >> 12) & 63) +
			BASE64URL.charAt((n >> 6) & 63) +
			BASE64URL.charAt(n & 63);
	}
	const rest = bytes.length - index;
	if (rest === 1) {
		const n = (bytes[index] ?? 0) << 16;
		out += BASE64URL.charAt((n >> 18) & 63) + BASE64URL.charAt((n >> 12) & 63);
	} else if (rest === 2) {
		const n = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
		out +=
			BASE64URL.charAt((n >> 18) & 63) +
			BASE64URL.charAt((n >> 12) & 63) +
			BASE64URL.charAt((n >> 6) & 63);
	}
	return out;
}

/**
 * Decodes base64url without padding. Only the canonical encoding is accepted
 * (unused trailing bits must be zero), so one value has one spelling.
 */
export function base64urlDecode(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
		throw new Error("Invalid base64url");
	}
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let buffer = 0;
	let bits = 0;
	let offset = 0;
	for (const char of text) {
		buffer = (buffer << 6) | BASE64URL.indexOf(char);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[offset++] = (buffer >> bits) & 0xff;
		}
	}
	if ((buffer & ((1 << bits) - 1)) !== 0) {
		throw new Error("Invalid base64url");
	}
	return out;
}

export function randomBytes(length: number): Uint8Array {
	const out = new Uint8Array(length);
	crypto.getRandomValues(out);
	return out;
}
