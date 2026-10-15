import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { guessMimeType, resolveAttachment } from "./attachments.ts";

test("bytes carried in the block are decoded and measured", async () => {
	// The 8-byte PNG signature, base64, as an ACP image block carries it.
	const resolved = await resolveAttachment({
		name: "image.png",
		mimeType: "image/png",
		data: "iVBORw0KGgo=",
	});

	expect(resolved).toMatchObject({
		ok: true,
		attachment: { name: "image.png", kind: "image", size: 8 },
	});
	expect(resolved.ok && [...(resolved.attachment.data ?? [])]).toEqual([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
});

test("a text resource is sent as its UTF-8 bytes, typed from its name", async () => {
	const resolved = await resolveAttachment({ name: "notes.md", text: "é" });

	expect(resolved).toMatchObject({
		ok: true,
		attachment: { size: 2, kind: "file" },
	});
	expect(resolved.ok && resolved.attachment.mimeType).toStartWith(
		"text/markdown",
	);
});

test("a directory is not a file", async () => {
	const dir = mkdtempSync(`${tmpdir()}/acpantenna-dir-`);
	try {
		expect(await resolveAttachment({ name: "x", path: dir })).toMatchObject({
			ok: false,
			reason: `${dir} is not a file.`,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("media types come from the extension, and unknown ones are bytes", () => {
	expect(guessMimeType("a.png")).toBe("image/png");
	expect(guessMimeType("IMG_0001.JPG")).toBe("image/jpeg");
	expect(guessMimeType("a.pdf")).toBe("application/pdf");
	expect(guessMimeType("a.weird-ext")).toBe("application/octet-stream");
});
