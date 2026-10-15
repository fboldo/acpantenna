import { stat } from "node:fs/promises";
import type { AcpAttachment } from "@acpantenna/acp";
import {
	attachmentKind,
	type ChannelAttachment,
	formatBytes,
} from "@acpantenna/channel";

export type ResolvedAttachment =
	| { ok: true; attachment: ChannelAttachment }
	| { ok: false; name: string; size: number; reason: string };

/**
 * An agent's attachment as a channel takes it: bytes or a path that exists,
 * its size, and a media type.
 *
 * A path is measured, not read. The channel checks the size against its own
 * limit first, so a file too large for it is refused without being loaded,
 * and the measurement is taken now rather than trusted from the agent: the
 * file may have changed since it said.
 */
export async function resolveAttachment(
	attachment: AcpAttachment,
): Promise<ResolvedAttachment> {
	const { name } = attachment;
	const mimeType = attachment.mimeType || guessMimeType(name);
	const kind = attachmentKind(mimeType);

	if (attachment.path) {
		const info = await stat(attachment.path).catch(() => undefined);

		if (!info) {
			return {
				ok: false,
				name,
				size: attachment.size ?? 0,
				reason: `${attachment.path} is not there any more.`,
			};
		}

		if (!info.isFile()) {
			return {
				ok: false,
				name,
				size: 0,
				reason: `${attachment.path} is not a file.`,
			};
		}

		return {
			ok: true,
			attachment: {
				name,
				mimeType,
				size: info.size,
				kind,
				path: attachment.path,
			},
		};
	}

	const data =
		attachment.data !== undefined
			? new Uint8Array(Buffer.from(attachment.data, "base64"))
			: attachment.text !== undefined
				? new TextEncoder().encode(attachment.text)
				: undefined;

	if (!data) {
		return { ok: false, name, size: 0, reason: "the agent sent no content." };
	}

	return {
		ok: true,
		attachment: { name, mimeType, size: data.byteLength, kind, data },
	};
}

/**
 * The media type for a name, from its extension. Bun's table, which knows
 * the common ones; anything else is plain bytes.
 */
export function guessMimeType(name: string): string {
	// Lowercased first: the table is case-sensitive, and a camera's
	// IMG_0001.JPG came back as plain bytes, to be sent as a download.
	const dot = name.lastIndexOf(".");
	const lower =
		dot < 0 ? name : name.slice(0, dot) + name.slice(dot).toLowerCase();
	return Bun.file(lower).type || "application/octet-stream";
}

/** What a channel that cannot carry files says instead of sending one. */
export function attachmentAsText(attachment: ChannelAttachment): string {
	const where = attachment.path
		? ` It is at ${attachment.path} on the agent's computer.`
		: "";
	return `📎 ${attachment.name} (${formatBytes(attachment.size)}): this channel cannot receive files.${where}`;
}
