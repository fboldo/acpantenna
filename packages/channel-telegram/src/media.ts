import { type ChannelAttachment, formatBytes } from "@acpantenna/channel";
import { TelegramApiError } from "./api.ts";

/** What the Bot API takes as an upload from a bot: 50 MB. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** sendPhoto takes up to 10 MB; a larger image goes as a document. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The method a file is sent with, and the field its bytes go in. */
export interface UploadMethod {
	method: "sendPhoto" | "sendVideo" | "sendAudio" | "sendDocument";
	field: "photo" | "video" | "audio" | "document";
}

export const DOCUMENT: UploadMethod = {
	method: "sendDocument",
	field: "document",
};

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4"];
const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a"];

/**
 * How a file is sent: a photo shown inline (JPEG, PNG, WebP up to 10 MB),
 * MP4 video and MP3/M4A audio played in the chat, anything else (a GIF,
 * which sendPhoto would flatten to a still, an SVG, a zip) as a document.
 */
export function uploadMethod(
	attachment: Pick<ChannelAttachment, "kind" | "mimeType" | "size">,
): UploadMethod {
	const type = attachment.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";

	if (
		attachment.kind === "image" &&
		PHOTO_TYPES.includes(type) &&
		attachment.size <= MAX_PHOTO_BYTES
	) {
		return { method: "sendPhoto", field: "photo" };
	}

	if (attachment.kind === "video" && VIDEO_TYPES.includes(type)) {
		return { method: "sendVideo", field: "video" };
	}

	if (attachment.kind === "audio" && AUDIO_TYPES.includes(type)) {
		return { method: "sendAudio", field: "audio" };
	}

	return DOCUMENT;
}

/** Why Telegram will refuse a file this size, in words for the chat, or undefined. */
export function uploadLimitProblem(size: number): string | undefined {
	return size > MAX_UPLOAD_BYTES
		? `Telegram bots can send files up to ${formatBytes(MAX_UPLOAD_BYTES)}.`
		: undefined;
}

/** Whether a failed upload was Telegram saying the file is too large. */
export function isTooLarge(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		(error.errorCode === 413 || /too (big|large)/i.test(error.description))
	);
}

/**
 * Whether sendPhoto refused the image as a photo (its dimensions, its
 * format) though it would go as a document.
 */
export function isPhotoRefused(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		error.errorCode === 400 &&
		/PHOTO_|IMAGE_PROCESS_FAILED/.test(error.description)
	);
}
