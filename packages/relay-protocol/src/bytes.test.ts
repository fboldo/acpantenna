import { expect, test } from "bun:test";
import {
	base64urlDecode,
	base64urlEncode,
	bytesToHex,
	equalBytes,
	hexToBytes,
} from "./bytes.ts";

test("base64url matches RFC 4648 without padding", () => {
	const cases: [string, string][] = [
		["", ""],
		["f", "Zg"],
		["fo", "Zm8"],
		["foo", "Zm9v"],
		["foob", "Zm9vYg"],
		["fooba", "Zm9vYmE"],
		["foobar", "Zm9vYmFy"],
	];
	for (const [text, encoded] of cases) {
		const bytes = new TextEncoder().encode(text);
		expect(base64urlEncode(bytes)).toBe(encoded);
		expect(base64urlDecode(encoded)).toEqual(bytes);
	}
	expect(base64urlEncode(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
	expect(() => base64urlDecode("Zg==")).toThrow();
	expect(() => base64urlDecode("Zh")).toThrow();
	expect(() => base64urlDecode("Z")).toThrow();
});

test("hex and equality", () => {
	expect(bytesToHex(hexToBytes("00ff10"))).toBe("00ff10");
	expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
	expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
	expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 3))).toBe(false);
});
