import { expect, test } from "bun:test";
import { discoverBaseUrl } from "./homeserver.ts";

const serving = (body: unknown, status = 200) =>
	(async () =>
		new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("a homeserver's well-known names where its client API is", async () => {
	expect(
		await discoverBaseUrl(
			"https://matrix.org/",
			serving({
				"m.homeserver": { base_url: "https://matrix-client.matrix.org/" },
			}),
		),
	).toBe("https://matrix-client.matrix.org");
});

test("without a usable well-known, the URL as given is the API", async () => {
	const unreachable = (async () => {
		throw new TypeError("fetch failed");
	}) as unknown as typeof fetch;

	expect(await discoverBaseUrl("https://hs.example/", unreachable)).toBe(
		"https://hs.example",
	);
	expect(await discoverBaseUrl("https://hs.example", serving({}, 404))).toBe(
		"https://hs.example",
	);
	expect(
		await discoverBaseUrl(
			"https://hs.example",
			serving({ "m.homeserver": { base_url: "javascript:alert(1)" } }),
		),
	).toBe("https://hs.example");
});
