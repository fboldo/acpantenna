import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { provideCryptoWasm, releaseCryptoWasm } from "./crypto-wasm.ts";

const EMBEDDED_WASM = Symbol.for("matrix-sdk-crypto-wasm.bytes");

test("the installed crypto loader carries the patch that reads embedded wasm", () => {
	// Without it a single-file bundle looks for pkg/*.wasm beside itself and
	// fails at startup; see patches/ and package.json patchedDependencies.
	const loader = Bun.resolveSync(
		"@matrix-org/matrix-sdk-crypto-wasm",
		import.meta.dir,
	);

	expect(loader.endsWith("node.mjs")).toBe(true);
	expect(readFileSync(loader, "utf8")).toContain(
		"globalThis[EMBEDDED_WASM] ?? (await readFile(filename))",
	);
});

test("the embedded wasm is the crypto module, intact", async () => {
	provideCryptoWasm();
	const bytes = (globalThis as Record<symbol, unknown>)[
		EMBEDDED_WASM
	] as Uint8Array;

	expect(WebAssembly.validate(bytes)).toBe(true);
	const module = await WebAssembly.compile(bytes);
	expect(
		WebAssembly.Module.exports(module).some(
			(entry) => entry.name === "__wbindgen_start",
		),
	).toBe(true);

	releaseCryptoWasm();
	expect(
		(globalThis as Record<symbol, unknown>)[EMBEDDED_WASM],
	).toBeUndefined();
});
