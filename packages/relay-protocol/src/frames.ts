/**
 * The plaintext of each transport message: a 14-byte header, the payload,
 * and zero padding up to a size bucket.
 *
 *     offset size field
 *     0      1    type     1 ACP, 2 CLOSE, 3 PING, 4 PONG, 5 CONFIRMED
 *     1      4    stream   u32 BE
 *     5      4    seq      u32 BE
 *     9      1    flags    bit0 FINAL
 *     10     4    length   u32 BE
 *     14     n    payload
 *     14+n   pad  zero bytes up to the bucket
 *
 * One ACP message is one stream, cut into chunks if it does not fit in one
 * frame. Control frames (CLOSE, PING, PONG, CONFIRMED) are single frames
 * with stream 0, seq 0 and FINAL set; ACP streams count from 1.
 */

import { concatBytes } from "./bytes.ts";
import { MAX_MESSAGE_LENGTH, TAGLEN } from "./noise.ts";

export const FrameType = {
	ACP: 1,
	CLOSE: 2,
	PING: 3,
	PONG: 4,
	/** Agent side to browser: the user has confirmed the SAS words. */
	CONFIRMED: 5,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const FLAG_FINAL = 0x01;
export const HEADER_LENGTH = 14;
/** The largest plaintext: one Noise message less its tag. */
export const MAX_PLAINTEXT_LENGTH = MAX_MESSAGE_LENGTH - TAGLEN;
/** The most payload one frame carries. */
export const MAX_CHUNK_PAYLOAD = MAX_PLAINTEXT_LENGTH - HEADER_LENGTH;
export const MIN_BUCKET = 256;
/** The largest ACP message a reassembler accepts by default: 32 MiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface Frame {
	type: FrameType;
	stream: number;
	seq: number;
	final: boolean;
	payload: Uint8Array;
}

/** A broken rule of the framing. The session must end: there is no resync. */
export class FrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrameError";
	}
}

/**
 * The padded size of a plaintext of `length` bytes: 256, else the next power
 * of two, capped at {@link MAX_PLAINTEXT_LENGTH}.
 */
export function bucketLength(length: number): number {
	if (length > MAX_PLAINTEXT_LENGTH) {
		throw new FrameError("Frame too long");
	}
	let bucket = MIN_BUCKET;
	while (bucket < length) {
		bucket *= 2;
	}
	return Math.min(bucket, MAX_PLAINTEXT_LENGTH);
}

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

/** Encodes a frame as a padded plaintext. */
export function encodeFrame(frame: Frame): Uint8Array {
	checkFrameShape(frame);
	const out = new Uint8Array(
		bucketLength(HEADER_LENGTH + frame.payload.length),
	);
	const view = new DataView(out.buffer);
	view.setUint8(0, frame.type);
	view.setUint32(1, frame.stream);
	view.setUint32(5, frame.seq);
	view.setUint8(9, frame.final ? FLAG_FINAL : 0);
	view.setUint32(10, frame.payload.length);
	out.set(frame.payload, HEADER_LENGTH);
	return out;
}

/**
 * Decodes a padded plaintext. Anything off — an unknown type or flag, a
 * length past the end, a size that is not the right bucket, non-zero
 * padding — throws a {@link FrameError}.
 */
export function decodeFrame(plaintext: Uint8Array): Frame {
	if (plaintext.length < HEADER_LENGTH) {
		throw new FrameError("Frame shorter than its header");
	}
	const view = new DataView(
		plaintext.buffer,
		plaintext.byteOffset,
		plaintext.byteLength,
	);
	const type = view.getUint8(0);
	const stream = view.getUint32(1);
	const seq = view.getUint32(5);
	const flags = view.getUint8(9);
	const length = view.getUint32(10);
	if (!KNOWN_TYPES.has(type)) {
		throw new FrameError(`Unknown frame type ${type}`);
	}
	if ((flags & ~FLAG_FINAL) !== 0) {
		throw new FrameError("Unknown frame flags");
	}
	if (HEADER_LENGTH + length > plaintext.length) {
		throw new FrameError("Frame length past the end");
	}
	if (plaintext.length !== bucketLength(HEADER_LENGTH + length)) {
		throw new FrameError("Frame not padded to its bucket");
	}
	for (let index = HEADER_LENGTH + length; index < plaintext.length; index++) {
		if (plaintext[index] !== 0) {
			throw new FrameError("Non-zero padding");
		}
	}
	const frame: Frame = {
		type: type as FrameType,
		stream,
		seq,
		final: (flags & FLAG_FINAL) !== 0,
		payload: plaintext.slice(HEADER_LENGTH, HEADER_LENGTH + length),
	};
	checkFrameShape(frame);
	return frame;
}

function checkFrameShape(frame: Frame): void {
	if (!KNOWN_TYPES.has(frame.type)) {
		throw new FrameError(`Unknown frame type ${frame.type}`);
	}
	if (frame.payload.length > MAX_CHUNK_PAYLOAD) {
		throw new FrameError("Frame payload too long");
	}
	if (!isUint32(frame.stream) || !isUint32(frame.seq)) {
		throw new FrameError("Stream and seq are 32-bit unsigned integers");
	}
	if (frame.type === FrameType.ACP) {
		if (frame.stream === 0) {
			throw new FrameError("ACP streams count from 1");
		}
		return;
	}
	if (frame.stream !== 0 || frame.seq !== 0 || !frame.final) {
		throw new FrameError("A control frame has stream 0, seq 0 and FINAL set");
	}
	if (frame.type === FrameType.CONFIRMED && frame.payload.length > 0) {
		throw new FrameError("CONFIRMED has no payload");
	}
}

function isUint32(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** A control frame: stream 0, seq 0, FINAL. */
export function controlFrame(
	type: Exclude<FrameType, typeof FrameType.ACP>,
	payload: Uint8Array = new Uint8Array(0),
): Frame {
	return { type, stream: 0, seq: 0, final: true, payload };
}

/**
 * Cuts one ACP message into the frames of stream `stream`. An empty message
 * is one empty FINAL frame.
 */
export function chunkMessage(
	stream: number,
	message: Uint8Array,
	maxChunk = MAX_CHUNK_PAYLOAD,
): Frame[] {
	if (maxChunk < 1 || maxChunk > MAX_CHUNK_PAYLOAD) {
		throw new FrameError("Chunk size out of range");
	}
	const frames: Frame[] = [];
	let offset = 0;
	do {
		const end = Math.min(offset + maxChunk, message.length);
		frames.push({
			type: FrameType.ACP,
			stream,
			seq: frames.length,
			final: end === message.length,
			payload: message.slice(offset, end),
		});
		offset = end;
	} while (offset < message.length);
	return frames;
}

/**
 * Puts the ACP streams of one direction back together, enforcing the rules:
 * stream ids go up by one from 1, seq goes up by one from 0, nothing is
 * interleaved, and a message stays under a size cap. Any breach throws a
 * {@link FrameError}.
 */
export class Reassembler {
	private lastStream = 0;
	private current:
		| { stream: number; nextSeq: number; chunks: Uint8Array[]; size: number }
		| undefined;

	constructor(private readonly maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {}

	/** Whether a stream has started and not yet ended. */
	get inStream(): boolean {
		return this.current !== undefined;
	}

	/** Takes one ACP frame; returns the whole message once its FINAL chunk arrives. */
	push(frame: Frame): Uint8Array | undefined {
		if (frame.type !== FrameType.ACP) {
			throw new FrameError("Only ACP frames are reassembled");
		}
		if (!this.current) {
			if (frame.stream !== this.lastStream + 1) {
				throw new FrameError(
					`Expected stream ${this.lastStream + 1}, got ${frame.stream}`,
				);
			}
			this.current = { stream: frame.stream, nextSeq: 0, chunks: [], size: 0 };
		}
		const current = this.current;
		if (frame.stream !== current.stream) {
			throw new FrameError("Streams interleaved");
		}
		if (frame.seq !== current.nextSeq) {
			throw new FrameError(`Expected seq ${current.nextSeq}, got ${frame.seq}`);
		}
		current.size += frame.payload.length;
		if (current.size > this.maxMessageBytes) {
			throw new FrameError("Message too large");
		}
		current.chunks.push(frame.payload);
		current.nextSeq++;
		if (!frame.final) {
			return undefined;
		}
		this.lastStream = current.stream;
		this.current = undefined;
		return concatBytes(...current.chunks);
	}

	/** Called on CLOSE: a stream still open then means the relay truncated it. */
	end(): void {
		if (this.current) {
			throw new FrameError("Stream left without FINAL");
		}
	}
}
