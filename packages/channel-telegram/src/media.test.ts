import { expect, test } from "bun:test";
import { TelegramApiError } from "./api.ts";
import {
	isPhotoRefused,
	isTooLarge,
	MAX_UPLOAD_BYTES,
	uploadLimitProblem,
	uploadMethod,
} from "./media.ts";

const MB = 1024 * 1024;

test("each kind of file goes the way Telegram shows it best", () => {
	expect(
		uploadMethod({ kind: "image", mimeType: "image/png", size: MB }),
	).toEqual({ method: "sendPhoto", field: "photo" });
	// A photo is recompressed to a still; a GIF goes as itself.
	expect(
		uploadMethod({ kind: "image", mimeType: "image/gif", size: MB }).method,
	).toBe("sendDocument");
	// sendPhoto takes up to 10 MB.
	expect(
		uploadMethod({ kind: "image", mimeType: "image/jpeg", size: 12 * MB })
			.method,
	).toBe("sendDocument");
	expect(
		uploadMethod({ kind: "video", mimeType: "video/mp4", size: MB }).method,
	).toBe("sendVideo");
	expect(
		uploadMethod({ kind: "audio", mimeType: "audio/mpeg", size: MB }).method,
	).toBe("sendAudio");
	expect(
		uploadMethod({ kind: "file", mimeType: "application/zip", size: MB }),
	).toEqual({ method: "sendDocument", field: "document" });
});

test("more than 50 MB is refused before anything is read", () => {
	expect(uploadLimitProblem(MAX_UPLOAD_BYTES)).toBeUndefined();
	expect(uploadLimitProblem(MAX_UPLOAD_BYTES + 1)).toBe(
		"Telegram bots can send files up to 50 MB.",
	);
});

test("refusals are told apart", () => {
	expect(
		isTooLarge(
			new TelegramApiError("sendDocument", 413, "Request Entity Too Large"),
		),
	).toBe(true);
	expect(
		isPhotoRefused(
			new TelegramApiError(
				"sendPhoto",
				400,
				"Bad Request: PHOTO_INVALID_DIMENSIONS",
			),
		),
	).toBe(true);
	expect(
		isPhotoRefused(
			new TelegramApiError("sendPhoto", 400, "Bad Request: chat not found"),
		),
	).toBe(false);
});
