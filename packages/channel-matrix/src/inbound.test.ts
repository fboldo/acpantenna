import { expect, test } from "bun:test";
import {
	describeMatrixError,
	isSenderAllowed,
	stripReplyFallback,
} from "./inbound.ts";

test("the allowlist decides who can invite and answer", () => {
	const policy = { mode: "allowlist" as const, allow: ["@me:matrix.org"] };

	expect(isSenderAllowed(policy, "@me:matrix.org")).toBe(true);
	expect(isSenderAllowed(policy, "@stranger:matrix.org")).toBe(false);
	expect(isSenderAllowed(undefined, "@me:matrix.org")).toBe(false);
	expect(
		isSenderAllowed(
			{ mode: "allowlist", allow: ["!room:matrix.org"] },
			"@anyone:x",
			"!room:matrix.org",
		),
	).toBe(true);
	expect(isSenderAllowed({ mode: "open" }, "@anyone:x")).toBe(true);
	expect(
		isSenderAllowed(
			{ mode: "closed", allow: ["@me:matrix.org"] },
			"@me:matrix.org",
		),
	).toBe(false);
});

test("a reply's quoted fallback is dropped", () => {
	expect(
		stripReplyFallback("> <@bot:matrix.org> Run it?\n> 1. Allow\n\n2"),
	).toBe("2");
	expect(stripReplyFallback("no quote here")).toBe("no quote here");
});

test("errors read as reasons a person can act on", () => {
	const hs = "https://matrix.org";

	expect(describeMatrixError({ errcode: "M_UNKNOWN_TOKEN" }, hs)).toBe(
		"The access token was rejected by matrix.org. Create a new one for the bot and update the channel.",
	);
	expect(describeMatrixError(new TypeError("fetch failed"), hs)).toBe(
		"Can't reach the homeserver at matrix.org; retrying.",
	);
	expect(
		describeMatrixError(
			{ message: "Unable to connect. Is the computer able to access the url?" },
			"http://localhost:6167",
		),
	).toBe("Can't reach the homeserver at localhost:6167; retrying.");
	expect(
		describeMatrixError({ httpStatus: 502, message: "Bad Gateway" }, hs),
	).toBe("matrix.org is having trouble (HTTP 502); retrying.");
	expect(describeMatrixError({ errcode: "M_LIMIT_EXCEEDED" }, hs)).toBe(
		"matrix.org is rate-limiting the bot; retrying.",
	);
});
