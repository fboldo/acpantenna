import { expect, test } from "bun:test";
import { attachmentKind, attachmentNotice, formatBytes } from "./index.ts";

test("how a file is shown follows its media type", () => {
	expect(attachmentKind("image/png")).toBe("image");
	expect(attachmentKind("IMAGE/JPEG; charset=binary")).toBe("image");
	expect(attachmentKind("image/svg+xml")).toBe("file");
	expect(attachmentKind("video/mp4")).toBe("video");
	expect(attachmentKind("audio/ogg")).toBe("audio");
	expect(attachmentKind("application/pdf")).toBe("file");
	expect(attachmentKind("")).toBe("file");
});

test("sizes read the way chat clients write them", () => {
	expect(formatBytes(0)).toBe("0 B");
	expect(formatBytes(1023)).toBe("1023 B");
	expect(formatBytes(1536)).toBe("1.5 KB");
	expect(formatBytes(52_428_800)).toBe("50 MB");
	expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
});

test("a file that did not go through says which, how big, and why", () => {
	expect(
		attachmentNotice({ name: "a.mp4", size: 80 * 1024 ** 2 }, "too big."),
	).toBe("⚠️ Could not send a.mp4 (80 MB): too big.");
});
