import { expect, test } from "bun:test";
import vectors from "../test-vectors/sas.json";
import { BIP39_ENGLISH } from "./bip39-english.ts";
import { hexToBytes } from "./bytes.ts";
import { sasWords } from "./sas.ts";

test("the BIP-39 English list has 2,048 sorted, distinct words", () => {
	expect(BIP39_ENGLISH.length).toBe(2048);
	expect(new Set(BIP39_ENGLISH).size).toBe(2048);
	expect([...BIP39_ENGLISH].sort()).toEqual([...BIP39_ENGLISH]);
	expect(BIP39_ENGLISH[0]).toBe("abandon");
	expect(BIP39_ENGLISH[2047]).toBe("zoo");
});

for (const vector of vectors.vectors) {
	test(`SAS of ${vector.h.slice(0, 16)}…`, () => {
		expect(sasWords(hexToBytes(vector.h))).toEqual(vector.words);
	});
}
