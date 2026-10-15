import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	base64urlDecode,
	base64urlEncode,
	generateKeyPair,
	type KeyPair,
} from "@acpantenna/relay-protocol";

/** The keychain service acpantenna keeps its secrets under. */
const KEYCHAIN_SERVICE = "acpantenna";
const KEY_FILE = "static-key";

/** Where a channel's key is read from and written to. */
export interface KeyStore {
	get(): Promise<string | null>;
	set(value: string): Promise<void>;
	delete(): Promise<void>;
}

/** Longest wait for the keychain: a background server cannot answer its prompts. */
const KEYCHAIN_TIMEOUT_MS = 10_000;

/** The OS keychain, under `<channel id>.relayKey`. */
export function keychainKeyStore(channelId: string): KeyStore {
	const name = `${channelId}.relayKey`;

	return {
		get: () =>
			withTimeout(Bun.secrets.get({ service: KEYCHAIN_SERVICE, name })),
		set: (value) =>
			withTimeout(Bun.secrets.set({ service: KEYCHAIN_SERVICE, name, value })),
		delete: async () => {
			await withTimeout(
				Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name }),
			);
		},
	};
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("The keychain did not answer.")),
					KEYCHAIN_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** A file only its owner can read, in the channel's state directory. */
export function fileKeyStore(stateDir: string): KeyStore {
	const path = join(stateDir, KEY_FILE);

	return {
		get: async () =>
			existsSync(path) ? readFileSync(path, "utf8").trim() : null,
		set: async (value) => {
			mkdirSync(stateDir, { recursive: true, mode: 0o700 });
			writeFileSync(path, `${value}\n`, { mode: 0o600 });
			chmodSync(path, 0o600);
		},
		delete: async () => {
			rmSync(path, { force: true });
		},
	};
}

/**
 * The channel's static X25519 key: the one in `stores`, the first that
 * answers, else a new one kept in the first that takes it. A browser checks
 * it against the key in the link.
 */
export async function loadStaticKey(stores: KeyStore[]): Promise<KeyPair> {
	let failure: unknown;

	for (const store of stores) {
		let stored: string | null;

		try {
			stored = await store.get();
		} catch (error) {
			failure = error;
			continue;
		}

		if (stored) {
			return generateKeyPair(base64urlDecode(stored));
		}

		const keyPair = generateKeyPair();

		try {
			await store.set(base64urlEncode(keyPair.privateKey));
			return keyPair;
		} catch (error) {
			failure = error;
		}
	}

	throw new Error(
		`Nowhere to keep the relay channel's key: ${failure instanceof Error ? failure.message : String(failure)}`,
	);
}

/**
 * Forgets the channel's key in every store, so the next one is new and no
 * link made with the old one works again. Throws if a store still holds it.
 */
export async function forgetStaticKey(stores: KeyStore[]): Promise<void> {
	for (const store of stores) {
		try {
			await store.delete();
		} catch (error) {
			// A keychain that is not there holds nothing; one that is must be emptied.
			let held: string | null;

			try {
				held = await store.get();
			} catch {
				continue;
			}

			if (held) {
				throw new Error(
					`Could not forget the relay channel's key: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}
