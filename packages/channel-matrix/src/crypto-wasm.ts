import { embeddedCryptoWasm } from "./crypto-wasm.macro.ts" with {
	type: "macro",
};

/**
 * Where the patched `@matrix-org/matrix-sdk-crypto-wasm` loader looks for the
 * wasm before reading `pkg/` beside itself, which a single-file bundle lacks.
 * See patches/ at the repo root.
 */
const EMBEDDED_WASM = Symbol.for("matrix-sdk-crypto-wasm.bytes");

type WasmGlobal = typeof globalThis & { [EMBEDDED_WASM]?: Uint8Array };

/** Hand the embedded wasm to the crypto loader. Call before `initRustCrypto`. */
export function provideCryptoWasm(): void {
	const scope = globalThis as WasmGlobal;

	scope[EMBEDDED_WASM] ??= Bun.gunzipSync(
		Buffer.from(embeddedCryptoWasm(), "base64"),
	);
}

/** Drop the bytes once the module is compiled; the instance keeps what it needs. */
export function releaseCryptoWasm(): void {
	delete (globalThis as WasmGlobal)[EMBEDDED_WASM];
}
