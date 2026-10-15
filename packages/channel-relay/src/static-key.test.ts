import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fileKeyStore,
	forgetStaticKey,
	type KeyStore,
	loadStaticKey,
} from "./static-key.ts";

test("the key is made once, kept, and read back", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-key-"));

	try {
		const store = fileKeyStore(join(dir, "channel"));
		const first = await loadStaticKey([store]);
		const again = await loadStaticKey([store]);

		expect(again.publicKey).toEqual(first.publicKey);

		if (process.platform !== "win32") {
			expect(statSync(join(dir, "channel", "static-key")).mode & 0o777).toBe(
				0o600,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a keychain that fails gives way to the next store", async () => {
	const broken: KeyStore = {
		get: async () => {
			throw new Error("no keychain");
		},
		set: async () => {
			throw new Error("no keychain");
		},
		delete: async () => {
			throw new Error("no keychain");
		},
	};
	let kept: string | null = null;
	const memory: KeyStore = {
		get: async () => kept,
		set: async (value) => {
			kept = value;
		},
		delete: async () => {
			kept = null;
		},
	};

	const keyPair = await loadStaticKey([broken, memory]);

	expect(kept).not.toBeNull();
	expect((await loadStaticKey([broken, memory])).publicKey).toEqual(
		keyPair.publicKey,
	);
	await expect(loadStaticKey([broken])).rejects.toThrow("no keychain");
});

test("a forgotten key is replaced by a new one", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acpantenna-key-"));

	try {
		const store = fileKeyStore(dir);
		const old = await loadStaticKey([store]);

		await forgetStaticKey([store]);
		expect(await store.get()).toBeNull();
		expect((await loadStaticKey([store])).publicKey).not.toEqual(old.publicKey);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
