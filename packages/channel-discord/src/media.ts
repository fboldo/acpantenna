import { type ChannelAttachment, formatBytes } from "@acpantenna/channel";
import { NO_MENTIONS } from "./format.ts";
import { DiscordApiError } from "./rest.ts";

/** Why Discord will refuse a file this size, in words for the channel, or undefined. */
export function uploadLimitProblem(
	size: number,
	limit: number,
): string | undefined {
	return size > limit
		? `Discord takes files up to ${formatBytes(limit)} here.`
		: undefined;
}

/** Whether a failed upload was Discord saying the file is too large. */
export function isTooLarge(error: unknown): boolean {
	return (
		error instanceof DiscordApiError &&
		(error.status === 413 || error.code === 40005)
	);
}

/**
 * The multipart body of a message with one file: `payload_json` names it
 * as attachment 0, and `files[0]` carries the bytes. Images show inline,
 * video and audio play, anything else is a download; Discord decides by type.
 */
export function uploadForm(
	attachment: Pick<ChannelAttachment, "name" | "mimeType">,
	bytes: Uint8Array,
	nonce?: string,
): FormData {
	const form = new FormData();

	form.append(
		"payload_json",
		JSON.stringify({
			attachments: [{ id: 0, filename: attachment.name }],
			allowed_mentions: NO_MENTIONS,
			...(nonce ? { nonce, enforce_nonce: true } : {}),
		}),
	);
	form.append(
		"files[0]",
		new Blob([bytes as Uint8Array<ArrayBuffer>], { type: attachment.mimeType }),
		attachment.name,
	);

	return form;
}
