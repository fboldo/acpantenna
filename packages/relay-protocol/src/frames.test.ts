import { describe, expect, test } from "bun:test";
import vectors from "../test-vectors/frames.json";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
	bucketLength,
	chunkMessage,
	controlFrame,
	decodeFrame,
	encodeFrame,
	type Frame,
	FrameError,
	FrameType,
	MAX_CHUNK_PAYLOAD,
	Reassembler,
} from "./frames.ts";

function pattern(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => index % 251);
}

describe("frame vectors", () => {
	for (const vector of vectors.valid) {
		test(`encodes and decodes: ${vector.description}`, () => {
			const frame: Frame = {
				type: vector.frame.type as Frame["type"],
				stream: vector.frame.stream,
				seq: vector.frame.seq,
				final: vector.frame.final,
				payload: hexToBytes(vector.frame.payload),
			};
			expect(bytesToHex(encodeFrame(frame))).toBe(vector.plaintext);
			expect(decodeFrame(hexToBytes(vector.plaintext))).toEqual(frame);
		});
	}

	for (const vector of vectors.invalid) {
		test(`refuses: ${vector.description}`, () => {
			expect(() => decodeFrame(hexToBytes(vector.plaintext))).toThrow(
				FrameError,
			);
		});
	}

	test("buckets", () => {
		for (const { length, padded } of vectors.buckets) {
			expect(bucketLength(length)).toBe(padded);
		}
	});

	test("chunking", () => {
		const { stream, length, frames } = vectors.chunking;
		const message = pattern(length);
		const chunks = chunkMessage(stream, message);
		expect(
			chunks.map((frame) => ({
				seq: frame.seq,
				final: frame.final,
				payloadLength: frame.payload.length,
				plaintextLength: encodeFrame(frame).length,
			})),
		).toEqual(frames);
		const reassembler = new Reassembler();
		for (const stream of [1, 2]) {
			for (const frame of chunkMessage(stream, new Uint8Array(1))) {
				reassembler.push(frame);
			}
		}
		let whole: Uint8Array | undefined;
		for (const chunk of chunks) {
			whole = reassembler.push(decodeFrame(encodeFrame(chunk)));
		}
		expect(whole).toEqual(message);
	});

	for (const vector of vectors.streams) {
		test(`streams: ${vector.description}`, () => {
			const reassembler = new Reassembler();
			const run = () => {
				let messages = 0;
				for (const step of vector.frames) {
					if (typeof step === "string") {
						reassembler.end();
						continue;
					}
					const done = reassembler.push({
						type: FrameType.ACP,
						stream: step.stream,
						seq: step.seq,
						final: step.final,
						payload: new Uint8Array(0),
					});
					if (done) {
						messages++;
					}
				}
				return messages;
			};
			if ("error" in vector) {
				expect(run).toThrow(FrameError);
			} else {
				expect(run()).toBe(vector.messages);
			}
		});
	}
});

describe("frames", () => {
	test("a plaintext never exceeds one Noise message less the tag", () => {
		const [frame] = chunkMessage(1, new Uint8Array(MAX_CHUNK_PAYLOAD));
		expect(encodeFrame(frame!).length).toBe(65535 - 16);
		expect(() =>
			encodeFrame({
				type: FrameType.ACP,
				stream: 1,
				seq: 0,
				final: true,
				payload: new Uint8Array(MAX_CHUNK_PAYLOAD + 1),
			}),
		).toThrow(FrameError);
	});

	test("an empty message is one empty FINAL frame", () => {
		expect(chunkMessage(4, new Uint8Array(0))).toEqual([
			{
				type: FrameType.ACP,
				stream: 4,
				seq: 0,
				final: true,
				payload: new Uint8Array(0),
			},
		]);
	});

	test("the reassembler caps the size of a message", () => {
		const reassembler = new Reassembler(10);
		reassembler.push({
			...chunkMessage(1, new Uint8Array(6))[0]!,
			final: false,
		});
		expect(() =>
			reassembler.push({
				...chunkMessage(1, new Uint8Array(6))[0]!,
				seq: 1,
			}),
		).toThrow("Message too large");
	});

	test("control frames refuse a stream", () => {
		expect(() =>
			encodeFrame({ ...controlFrame(FrameType.PING), stream: 1 }),
		).toThrow(FrameError);
	});
});
