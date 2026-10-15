import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A Bun macro: runs when the code is bundled (or transpiled from source) and
 * returns the Rust crypto's wasm, gzipped and base64-encoded, to be inlined as
 * a string. That is how a single-file `bun build` carries the wasm with it.
 */
export function embeddedCryptoWasm(): string {
	const entry = Bun.resolveSync(
		"@matrix-org/matrix-sdk-crypto-wasm",
		import.meta.dir,
	);
	const wasm = readFileSync(
		join(dirname(entry), "pkg/matrix_sdk_crypto_wasm_bg.wasm"),
	);

	return Buffer.from(Bun.gzipSync(wasm, { level: 9 })).toString("base64");
}
