import { expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import {
	encryptAttachment,
	imageDimensions,
	isTooLarge,
	mediaContent,
	uploadLimitProblem,
} from "./media.ts";

// Headers of real files, 37×21, made with ImageMagick's `convert -size 37x21
// xc:red a.png|a.gif|a.jpg`. The JPEG's frame header sits after its JFIF and
// two quantisation-table segments, which is the case a hand-made one skips.
const PNG = "89504e470d0a1a0a0000000d4948445200000025000000150103000000fb2ab5";
const GIF = "47494638396125001500f00000ff000000000021f904000000000021ff0b496d";
const JPEG =
	"ffd8ffe000104a46494600010100000000000000ffdb004300030202020202030202020303030304060404040404080606050609080a0a090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c12131210130f101010ffdb00430103030304030408040408100b090b1010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010ffc000110800150025030111";

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

test("reads an image's size from its header", () => {
	expect(imageDimensions(hex(PNG))).toEqual({ w: 37, h: 21 });
	expect(imageDimensions(hex(GIF))).toEqual({ w: 37, h: 21 });
	expect(imageDimensions(hex(JPEG))).toEqual({ w: 37, h: 21 });
});

test("an unknown or truncated header has no size", () => {
	expect(
		imageDimensions(new TextEncoder().encode("not an image")),
	).toBeUndefined();
	expect(imageDimensions(hex(JPEG).subarray(0, 100))).toBeUndefined();
});

test("an encrypted attachment decrypts with the key and IV it names", async () => {
	const plaintext = new TextEncoder().encode(
		"a screenshot, notionally ".repeat(50),
	);
	const { data, file } = await encryptAttachment(plaintext);

	expect(file.v).toBe("v2");
	expect(file.key).toMatchObject({ kty: "oct", alg: "A256CTR", ext: true });
	expect(file.key.key_ops).toEqual(["encrypt", "decrypt"]);
	// Unpadded base64(url): 32 key bytes are 43 characters, 16 IV bytes 22.
	expect(file.key.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(file.iv).toMatch(/^[A-Za-z0-9+/]{22}$/);

	const iv = Buffer.from(file.iv, "base64");
	// The counter's low half starts at zero, as the spec asks.
	expect([...iv.subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

	// Checked with Node's own AES, not the WebCrypto that produced it.
	const decipher = createDecipheriv(
		"aes-256-ctr",
		Buffer.from(file.key.k, "base64url"),
		iv,
	);
	const back = Buffer.concat([decipher.update(data), decipher.final()]);
	expect(back.equals(Buffer.from(plaintext))).toBe(true);

	const sha = createHash("sha256")
		.update(data)
		.digest("base64")
		.replace(/=+$/, "");
	expect(file.hashes.sha256).toBe(sha);
});

test("an empty file hashes to SHA-256 of nothing", async () => {
	const { file } = await encryptAttachment(new Uint8Array());
	expect(file.hashes.sha256).toBe(
		"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
	);
});

test("the message for an image, a plain room and an encrypted one", () => {
	const shot = {
		name: "screen.png",
		mimeType: "image/png",
		size: 4096,
		kind: "image" as const,
	};

	expect(
		mediaContent(shot, { url: "mxc://example.org/abc" }, { w: 37, h: 21 }),
	).toEqual({
		msgtype: "m.image",
		body: "screen.png",
		filename: "screen.png",
		info: { mimetype: "image/png", size: 4096, w: 37, h: 21 },
		url: "mxc://example.org/abc",
	});

	const pdf = {
		name: "r.pdf",
		mimeType: "application/pdf",
		size: 9,
		kind: "file" as const,
	};
	const encrypted = mediaContent(pdf, {
		file: {
			url: "mxc://example.org/def",
			key: {
				kty: "oct",
				key_ops: ["encrypt", "decrypt"],
				alg: "A256CTR",
				k: "k",
				ext: true,
			},
			iv: "iv",
			hashes: { sha256: "h" },
			v: "v2",
		},
	});
	expect(encrypted.msgtype).toBe("m.file");
	expect(encrypted.url).toBeUndefined();
	expect(encrypted.file?.url).toBe("mxc://example.org/def");
});

test("a file over the homeserver's limit is refused before upload, in words", () => {
	expect(uploadLimitProblem(60_000_000, 52_428_800, "matrix.org")).toBe(
		"matrix.org accepts files up to 50 MB.",
	);
	expect(uploadLimitProblem(10, 52_428_800, "matrix.org")).toBeUndefined();
	expect(uploadLimitProblem(10 ** 12, undefined, "matrix.org")).toBeUndefined();
});

test("recognises the homeserver's too-large answer", () => {
	expect(isTooLarge({ httpStatus: 413 })).toBe(true);
	expect(isTooLarge({ data: { errcode: "M_TOO_LARGE" } })).toBe(true);
	expect(isTooLarge({ httpStatus: 500 })).toBe(false);
});
