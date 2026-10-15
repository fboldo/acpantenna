import { type ChannelAttachment, formatBytes } from "@acpantenna/channel";

/**
 * A file sent into a room: `m.image` shows inline, `m.video` and `m.audio`
 * play, `m.file` is a download. `url` in a plain room; `file` (the key and
 * the ciphertext's hash, spec "Sending encrypted attachments") in an
 * encrypted one, where the homeserver holds only ciphertext.
 */
export interface MediaContent {
	msgtype: "m.image" | "m.video" | "m.audio" | "m.file";
	body: string;
	filename: string;
	info: { mimetype: string; size: number; w?: number; h?: number };
	url?: string;
	file?: EncryptedFile;
}

/** The spec's EncryptedFile, v2: AES-256-CTR, the key as a JWK. */
export interface EncryptedFile {
	url: string;
	key: {
		kty: "oct";
		key_ops: ["encrypt", "decrypt"];
		alg: "A256CTR";
		k: string;
		ext: true;
	};
	iv: string;
	hashes: { sha256: string };
	v: "v2";
}

const MSGTYPE: Record<ChannelAttachment["kind"], MediaContent["msgtype"]> = {
	image: "m.image",
	video: "m.video",
	audio: "m.audio",
	file: "m.file",
};

export function mediaContent(
	attachment: Pick<ChannelAttachment, "name" | "mimeType" | "size" | "kind">,
	uploaded: { url: string } | { file: EncryptedFile },
	dimensions?: { w: number; h: number },
): MediaContent {
	return {
		msgtype: MSGTYPE[attachment.kind],
		// `body` is the caption when `filename` is set (spec v1.10); with no
		// caption of its own, a file is captioned with its name, which is
		// what clients older than that show in any case.
		body: attachment.name,
		filename: attachment.name,
		info: {
			mimetype: attachment.mimeType,
			size: attachment.size,
			...(dimensions ?? {}),
		},
		...uploaded,
	};
}

/**
 * Why the homeserver will refuse a file this size, in words for the room, or
 * undefined. The limit is its `m.upload.size` (GET /media/config); a server
 * that does not say has no stated limit, and its refusal is caught instead.
 */
export function uploadLimitProblem(
	size: number,
	limit: number | undefined,
	host: string,
): string | undefined {
	if (limit === undefined || size <= limit) {
		return undefined;
	}

	return `${host} accepts files up to ${formatBytes(limit)}.`;
}

/** Whether a failed upload was the homeserver saying the file is too large. */
export function isTooLarge(error: unknown): boolean {
	const candidate = (error ?? {}) as {
		errcode?: string;
		httpStatus?: number;
		data?: { errcode?: string };
	};
	return (
		candidate.httpStatus === 413 ||
		(candidate.errcode ?? candidate.data?.errcode) === "M_TOO_LARGE"
	);
}

/**
 * Width and height from a PNG, JPEG or GIF header, or undefined. Clients lay
 * an image out from `info.w`/`info.h` before it has downloaded; without them
 * the room jumps when it arrives. Read from the bytes, not decoded.
 */
export function imageDimensions(
	bytes: Uint8Array,
): { w: number; h: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// PNG: the signature, then IHDR, whose first fields are width and height.
	if (
		bytes.length >= 24 &&
		view.getUint32(0) === 0x89504e47 &&
		view.getUint32(12) === 0x49484452
	) {
		return { w: view.getUint32(16), h: view.getUint32(20) };
	}

	// GIF87a / GIF89a: logical screen size, little-endian.
	if (bytes.length >= 10 && view.getUint32(0) === 0x47494638) {
		return { w: view.getUint16(6, true), h: view.getUint16(8, true) };
	}

	// JPEG: walk the segments to the first start-of-frame.
	if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
		let at = 2;

		while (at + 9 <= bytes.length) {
			if (bytes[at] !== 0xff) {
				return undefined;
			}

			const marker = bytes[at + 1] ?? 0;

			// Fill bytes before a marker.
			if (marker === 0xff) {
				at += 1;
				continue;
			}

			const isFrame =
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc;

			if (isFrame) {
				return { h: view.getUint16(at + 5), w: view.getUint16(at + 7) };
			}

			at += 2 + view.getUint16(at + 2);
		}
	}

	return undefined;
}

/**
 * Encrypt a file for an encrypted room, as the spec describes: AES-256-CTR
 * under a fresh key, a 128-bit counter block whose low 64 bits start at zero
 * (so a file up to 2^64 blocks never wraps), and the SHA-256 of the
 * *ciphertext*, which is what a client checks before decrypting.
 * `iv` and the hash are unpadded base64; the key is unpadded base64url.
 */
export async function encryptAttachment(
	plaintext: Uint8Array,
): Promise<{ data: Uint8Array; file: Omit<EncryptedFile, "url"> }> {
	const key = await crypto.subtle.generateKey(
		{ name: "AES-CTR", length: 256 },
		true,
		["encrypt", "decrypt"],
	);
	const iv = new Uint8Array(16);
	crypto.getRandomValues(iv.subarray(0, 8));
	const data = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-CTR", counter: iv, length: 64 },
			key,
			// Never shared memory here; the DOM typing only cannot know it.
			plaintext as Uint8Array<ArrayBuffer>,
		),
	);
	const jwk = await crypto.subtle.exportKey("jwk", key);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));

	return {
		data,
		file: {
			key: {
				kty: "oct",
				key_ops: ["encrypt", "decrypt"],
				alg: "A256CTR",
				k: jwk.k ?? "",
				ext: true,
			},
			iv: unpadded(iv),
			hashes: { sha256: unpadded(hash) },
			v: "v2",
		},
	};
}

function unpadded(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}
