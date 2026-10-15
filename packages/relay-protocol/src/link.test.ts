import { describe, expect, test } from "bun:test";
import { bytesToHex } from "./bytes.ts";
import {
	encodeLink,
	isLinkExpired,
	LinkError,
	normalizeWebOrigin,
	type PairingLink,
	parseLink,
	prologue,
	roomId,
} from "./link.ts";

const link: PairingLink = {
	webOrigin: "https://app.example",
	room: Uint8Array.from({ length: 16 }, (_, index) => index),
	staticPublicKey: new Uint8Array(32).fill(1),
	psk: new Uint8Array(32).fill(2),
	expiry: 1_800_000_000,
};

describe("link", () => {
	test("round-trips", () => {
		const text = encodeLink(link);
		expect(text).toBe(
			"https://app.example/#v1.AAECAwQFBgcICQoLDA0ODw.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE.AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI.1800000000",
		);
		expect(parseLink(text)).toEqual(link);
		expect(roomId(link.room)).toHaveLength(22);
	});

	test("expires", () => {
		expect(isLinkExpired(link, 1_800_000_000 * 1000 - 1)).toBe(false);
		expect(isLinkExpired(link, 1_800_000_000 * 1000)).toBe(true);
	});

	test.each([
		["no fragment", "https://app.example/"],
		["another version", "https://app.example/#v2.a.b.c.1"],
		[
			"a short room",
			encodeLink(link).replace("AAECAwQFBgcICQoLDA0ODw", "AAEC"),
		],
		["a padded field", encodeLink(link).replace(".1800000000", "=.1800000000")],
		["a non-canonical field", encodeLink(link).replace("ODw.", "ODx.")],
		["a bad expiry", encodeLink(link).replace("1800000000", "18e8")],
		["a path", encodeLink(link).replace("/#", "/x/#")],
		["another scheme", encodeLink(link).replace("https:", "ftp:")],
	])("refuses %s", (_name, text) => {
		expect(() => parseLink(text)).toThrow(LinkError);
	});

	test("origins are a scheme and host only", () => {
		expect(normalizeWebOrigin("https://app.example/")).toBe(
			"https://app.example",
		);
		expect(normalizeWebOrigin("http://localhost:8080")).toBe(
			"http://localhost:8080",
		);
		expect(() => normalizeWebOrigin("https://app.example/path")).toThrow(
			LinkError,
		);
	});

	test("the prologue binds the label, the room and the origin", () => {
		expect(bytesToHex(prologue(link.room, link.webOrigin))).toBe(
			`${bytesToHex(new TextEncoder().encode("acpantenna-relay/1"))}00${bytesToHex(link.room)}00${bytesToHex(new TextEncoder().encode("https://app.example"))}`,
		);
	});
});
