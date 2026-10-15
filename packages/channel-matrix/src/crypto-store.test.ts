import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoStoreFile, installIndexedDb } from "./crypto-store.ts";

const directory = mkdtempSync(join(tmpdir(), "matrix-crypto-store-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

type Request = {
	result: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onupgradeneeded?: (() => void) | null;
};
// biome-ignore lint/suspicious/noExplicitAny: the IndexedDB API, untyped here.
const idb = () => (globalThis as any).indexedDB;
const done = (request: Request) =>
	new Promise<unknown>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new Error("request failed"));
	});

test("databases written by the crypto survive a restart", async () => {
	installIndexedDb();
	const path = join(directory, "crypto.bin");
	const store = new CryptoStoreFile({ path, prefix: "bot:", debounceMs: 10 });
	await store.load();

	const opening = idb().open("bot:matrix-sdk-crypto", 3);
	opening.onupgradeneeded = () => {
		const database = opening.result;
		database.createObjectStore("core");
		const sessions = database.createObjectStore("sessions", {
			keyPath: ["room", "id"],
		});
		sessions.createIndex("room", "room", { unique: false });
	};
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	const database = (await done(opening)) as any;
	const writing = database.transaction(["core", "sessions"], "readwrite");
	writing.objectStore("core").put(new Uint8Array([1, 2, 3]), "account");
	writing.objectStore("sessions").put({ room: "!a", id: "s1", key: "k1" });
	writing.objectStore("sessions").put({ room: "!b", id: "s2", key: "k2" });
	await new Promise((resolve) => {
		writing.oncomplete = resolve;
	});
	database.close();

	// Another bot's store in the same process is not this file's business.
	const other = idb().open("other:matrix-sdk-crypto", 1);
	other.onupgradeneeded = () => other.result.createObjectStore("core");
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	((await done(other)) as any).close();

	await store.close();
	// Windows has no owner-only modes; its user profile's access rules apply.
	if (process.platform !== "win32") {
		expect(statSync(path).mode & 0o777).toBe(0o600);
	}

	// A fresh process: nothing in memory until the file is loaded.
	await done(idb().deleteDatabase("bot:matrix-sdk-crypto"));
	await done(idb().deleteDatabase("other:matrix-sdk-crypto"));
	const restarted = new CryptoStoreFile({ path, prefix: "bot:" });
	await restarted.load();

	const names = (await idb().databases()).map(
		(info: { name: string }) => info.name,
	);
	expect(names).toEqual(["bot:matrix-sdk-crypto"]);

	// biome-ignore lint/suspicious/noExplicitAny: see above.
	const reopened = (await done(idb().open("bot:matrix-sdk-crypto"))) as any;
	expect(reopened.version).toBe(3);
	const reading = reopened.transaction(["core", "sessions"], "readonly");
	expect(await done(reading.objectStore("core").get("account"))).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	expect(
		await done(reading.objectStore("sessions").index("room").getAll("!b")),
	).toEqual([{ room: "!b", id: "s2", key: "k2" }]);
	reopened.close();
	await restarted.close();
});

test("a change is written again shortly after it happens", async () => {
	installIndexedDb();
	const path = join(directory, "debounced.bin");
	const store = new CryptoStoreFile({ path, prefix: "late:", debounceMs: 10 });
	await store.load();

	const opening = idb().open("late:db", 1);
	opening.onupgradeneeded = () => opening.result.createObjectStore("core");
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	const database = (await done(opening)) as any;
	const writing = database.transaction(["core"], "readwrite");
	writing.objectStore("core").put("v1", "key");
	await new Promise((resolve) => {
		writing.oncomplete = resolve;
	});
	database.close();

	await Bun.sleep(100);
	expect(statSync(path).size).toBeGreaterThan(0);
	await store.close();
});
