/**
 * The short authentication string: four words both sides show, so the user
 * can see they are talking to the same peer. They come from
 * `BLAKE2s("acpantenna-sas" ‖ h)`, `h` being the final handshake hash: its
 * first 44 bits, most significant first, as four 11-bit indexes into the
 * BIP-39 English wordlist.
 */

import { blake2s } from "@noble/hashes/blake2.js";
import { BIP39_ENGLISH } from "./bip39-english.ts";
import { concatBytes, utf8Encode } from "./bytes.ts";

export const SAS_LABEL = "acpantenna-sas";
export const SAS_WORDS = 4;

export function sasWords(handshakeHash: Uint8Array): string[] {
	const digest = blake2s(concatBytes(utf8Encode(SAS_LABEL), handshakeHash));
	const words: string[] = [];
	for (let word = 0; word < SAS_WORDS; word++) {
		let index = 0;
		for (let bit = word * 11; bit < word * 11 + 11; bit++) {
			const byte = digest[bit >> 3] ?? 0;
			index = (index << 1) | ((byte >> (7 - (bit & 7))) & 1);
		}
		words.push(BIP39_ENGLISH[index] as string);
	}
	return words;
}
