import { expect, test } from "bun:test";
import { isTooLarge, uploadForm, uploadLimitProblem } from "./media.ts";
import { DiscordApiError } from "./rest.ts";

test("a file over the limit is refused before it is read", () => {
	expect(uploadLimitProblem(5, 10)).toBeUndefined();
	expect(uploadLimitProblem(11 * 1024 * 1024, 10 * 1024 * 1024)).toBe(
		"Discord takes files up to 10 MB here.",
	);
});

test("Discord's too-large answers are recognised", () => {
	expect(isTooLarge(new DiscordApiError(413, undefined, "x"))).toBe(true);
	expect(isTooLarge(new DiscordApiError(400, 40005, "x"))).toBe(true);
	expect(isTooLarge(new DiscordApiError(403, 50013, "x"))).toBe(false);
	expect(isTooLarge(new Error("x"))).toBe(false);
});

test("an upload is multipart: the payload names the file, the file carries the bytes", async () => {
	const form = uploadForm(
		{ name: "shot.png", mimeType: "image/png" },
		new Uint8Array([1, 2, 3]),
		"abc",
	);
	const payload = JSON.parse(String(form.get("payload_json")));
	const file = form.get("files[0]") as File;

	expect(payload).toEqual({
		attachments: [{ id: 0, filename: "shot.png" }],
		allowed_mentions: { parse: [] },
		nonce: "abc",
		enforce_nonce: true,
	});
	expect(file.name).toBe("shot.png");
	expect(file.type).toBe("image/png");
	expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
});
