import { deserialize, serialize } from "bun:jsc";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as fakeIndexedDb from "fake-indexeddb";

/**
 * The Rust crypto (as wasm) keeps its keys in IndexedDB, which Bun does not
 * have. fake-indexeddb provides it in memory; this file keeps a copy on disk:
 * it is restored before the crypto opens its store and written again shortly
 * after every change, so the bot keeps its device keys and Olm/Megolm
 * sessions across restarts.
 */

/*
 * The slice of the IndexedDB API used here, typed locally: the package builds
 * without the DOM lib.
 */
type IdbKey = unknown;

interface IdbRequest<T> {
	result: T;
	error: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
}

interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
	onupgradeneeded: (() => void) | null;
}

interface IdbStringList extends Iterable<string> {
	contains(name: string): boolean;
}

interface IdbCursor {
	primaryKey: IdbKey;
	value: unknown;
	continue(): void;
}

interface IdbIndex {
	keyPath: string | string[];
	unique: boolean;
	multiEntry: boolean;
}

interface IdbStore {
	keyPath: string | string[] | null;
	autoIncrement: boolean;
	indexNames: IdbStringList;
	transaction: IdbTransaction;
	index(name: string): IdbIndex;
	openCursor(): IdbRequest<IdbCursor | null>;
	put(value: unknown, key?: IdbKey): unknown;
	createIndex(
		name: string,
		keyPath: string | string[],
		options: { unique: boolean; multiEntry: boolean },
	): unknown;
}

interface IdbTransaction {
	db: IdbDatabase;
	error: unknown;
	objectStore(name: string): IdbStore;
	oncomplete: (() => void) | null;
	onerror: (() => void) | null;
	onabort: (() => void) | null;
}

interface IdbDatabase {
	name: string;
	version: number;
	objectStoreNames: IdbStringList;
	transaction(names: string[], mode: "readonly" | "readwrite"): IdbTransaction;
	createObjectStore(
		name: string,
		options: { keyPath: string | string[] | null; autoIncrement: boolean },
	): IdbStore;
	close(): void;
}

interface IdbFactory {
	open(name: string, version?: number): IdbOpenRequest;
	databases(): Promise<Array<{ name?: string; version?: number }>>;
}

/** The factory the crypto uses: the global, which installIndexedDb provides. */
function factory(): IdbFactory {
	return (globalThis as unknown as { indexedDB: IdbFactory }).indexedDB;
}

interface StoreDump {
	name: string;
	keyPath: string | string[] | null;
	autoIncrement: boolean;
	indexes: Array<{
		name: string;
		keyPath: string | string[];
		unique: boolean;
		multiEntry: boolean;
	}>;
	records: Array<[IdbKey, unknown]>;
}

interface DatabaseDump {
	name: string;
	version: number;
	stores: StoreDump[];
}

interface SnapshotFile {
	version: 1;
	databases: DatabaseDump[];
}

type WriteListener = (databaseName: string) => void;

const writeListeners = new Set<WriteListener>();
let installed = false;

/** Provide IndexedDB globals (where missing) and report every write. */
export function installIndexedDb(): void {
	if (installed) {
		return;
	}

	installed = true;
	const globals: Record<string, unknown> = {
		indexedDB: fakeIndexedDb.indexedDB,
		IDBCursor: fakeIndexedDb.IDBCursor,
		IDBCursorWithValue: fakeIndexedDb.IDBCursorWithValue,
		IDBDatabase: fakeIndexedDb.IDBDatabase,
		IDBFactory: fakeIndexedDb.IDBFactory,
		IDBIndex: fakeIndexedDb.IDBIndex,
		IDBKeyRange: fakeIndexedDb.IDBKeyRange,
		IDBObjectStore: fakeIndexedDb.IDBObjectStore,
		IDBOpenDBRequest: fakeIndexedDb.IDBOpenDBRequest,
		IDBRequest: fakeIndexedDb.IDBRequest,
		IDBTransaction: fakeIndexedDb.IDBTransaction,
		IDBVersionChangeEvent: fakeIndexedDb.IDBVersionChangeEvent,
	};

	for (const [name, value] of Object.entries(globals)) {
		if (!(name in globalThis)) {
			Object.defineProperty(globalThis, name, {
				value,
				configurable: true,
				writable: true,
			});
		}
	}

	const prototype = (
		fakeIndexedDb.IDBObjectStore as unknown as { prototype: object }
	).prototype as Record<string, (...args: unknown[]) => unknown>;

	for (const method of ["put", "add", "delete", "clear"]) {
		const original = prototype[method];

		if (!original) {
			continue;
		}

		prototype[method] = function (this: IdbStore, ...args: unknown[]) {
			const result = original.apply(this, args);
			const name = this.transaction.db.name;

			for (const listener of writeListeners) {
				listener(name);
			}

			return result;
		};
	}
}

function request<T>(pending: IdbRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		pending.onsuccess = () => resolve(pending.result);
		pending.onerror = () => reject(pending.error);
	});
}

async function dumpDatabase(
	idb: IdbFactory,
	name: string,
): Promise<DatabaseDump> {
	const database = await request(idb.open(name));

	try {
		const names = [...database.objectStoreNames];
		const stores: StoreDump[] = [];

		if (names.length > 0) {
			const transaction = database.transaction(names, "readonly");

			for (const storeName of names) {
				const store = transaction.objectStore(storeName);
				const records: Array<[IdbKey, unknown]> = [];

				await new Promise<void>((resolve, reject) => {
					const cursor = store.openCursor();
					cursor.onsuccess = () => {
						const current = cursor.result;

						if (!current) {
							resolve();
							return;
						}

						records.push([current.primaryKey, current.value]);
						current.continue();
					};
					cursor.onerror = () => reject(cursor.error);
				});

				stores.push({
					name: storeName,
					keyPath: store.keyPath,
					autoIncrement: store.autoIncrement,
					indexes: [...store.indexNames].map((indexName) => {
						const index = store.index(indexName);
						return {
							name: indexName,
							keyPath: index.keyPath,
							unique: index.unique,
							multiEntry: index.multiEntry,
						};
					}),
					records,
				});
			}
		}

		return { name, version: database.version, stores };
	} finally {
		database.close();
	}
}

async function restoreDatabase(
	idb: IdbFactory,
	dump: DatabaseDump,
): Promise<void> {
	const opening = idb.open(dump.name, dump.version);

	opening.onupgradeneeded = () => {
		const database = opening.result;

		for (const store of dump.stores) {
			if (database.objectStoreNames.contains(store.name)) {
				continue;
			}

			const created = database.createObjectStore(store.name, {
				keyPath: store.keyPath,
				autoIncrement: store.autoIncrement,
			});

			for (const index of store.indexes) {
				created.createIndex(index.name, index.keyPath, {
					unique: index.unique,
					multiEntry: index.multiEntry,
				});
			}
		}
	};

	const database = await request(opening);

	try {
		if (dump.stores.length === 0) {
			return;
		}

		const transaction = database.transaction(
			dump.stores.map((store) => store.name),
			"readwrite",
		);

		for (const store of dump.stores) {
			const target = transaction.objectStore(store.name);

			for (const [key, value] of store.records) {
				if (store.keyPath === null) {
					target.put(value, key);
				} else {
					target.put(value);
				}
			}
		}

		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		database.close();
	}
}

export interface CryptoStoreFileOptions {
	/** The snapshot file. */
	path: string;
	/** Only databases whose name starts with this are kept (one bot's store). */
	prefix: string;
	/** Quiet time after a write before the file is rewritten. Default 500ms. */
	debounceMs?: number;
	onError?: (error: unknown) => void;
}

/** The on-disk copy of one bot's crypto databases. */
export class CryptoStoreFile {
	private timer?: ReturnType<typeof setTimeout>;
	private dirty = false;
	private saving?: Promise<void>;
	private readonly listener: WriteListener;

	public constructor(private readonly options: CryptoStoreFileOptions) {
		this.listener = (name) => {
			if (name.startsWith(options.prefix)) {
				this.markDirty();
			}
		};
	}

	/** Whether there is a copy on disk to restore. */
	public get exists(): boolean {
		return existsSync(this.options.path);
	}

	/** Restore the databases from disk, then start following writes. */
	public async load(): Promise<void> {
		installIndexedDb();

		if (existsSync(this.options.path)) {
			const file = deserialize(
				await readFile(this.options.path),
			) as SnapshotFile;

			for (const database of file.databases) {
				await restoreDatabase(factory(), database);
			}
		}

		writeListeners.add(this.listener);
	}

	/** Write the file now if anything changed since the last write. */
	public async save(): Promise<void> {
		if (this.saving) {
			await this.saving;
		}

		if (!this.dirty) {
			return;
		}

		this.dirty = false;
		this.saving = this.write().finally(() => {
			this.saving = undefined;
		});
		await this.saving;
	}

	/** Stop following writes, after a last save. */
	public async close(): Promise<void> {
		writeListeners.delete(this.listener);
		clearTimeout(this.timer);
		await this.save();
	}

	private markDirty(): void {
		this.dirty = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.save().catch((error) => this.options.onError?.(error));
		}, this.options.debounceMs ?? 500);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private async write(): Promise<void> {
		try {
			const databases: DatabaseDump[] = [];

			for (const info of await factory().databases()) {
				if (info.name?.startsWith(this.options.prefix)) {
					databases.push(await dumpDatabase(factory(), info.name));
				}
			}

			const file: SnapshotFile = { version: 1, databases };
			const directory = dirname(this.options.path);
			const temporary = `${this.options.path}.tmp`;

			mkdirSync(directory, { recursive: true, mode: 0o700 });
			await writeFile(temporary, Buffer.from(serialize(file)), { mode: 0o600 });
			chmodSync(temporary, 0o600);
			renameSync(temporary, this.options.path);
		} catch (error) {
			// Keep it dirty so the next write tries again.
			this.dirty = true;
			throw error;
		}
	}
}
