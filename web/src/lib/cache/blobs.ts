/**
 * The local blob cache: segment indexes and term shards as the server
 * holds them, ciphertext under the blob key, keyed by blob id. Blobs are
 * write-once and named by their content or an HMAC, so an entry is never
 * stale; the cache only ever grows with the archive and is dropped whole.
 * A disk that leaks the cache leaks what the server already had. Every
 * failure of the store, a browser without IndexedDB included, degrades to
 * a miss: the network still answers.
 */
import type { Bytes } from '$lib/api/types';

const DB = 'mailarchive';
const STORE = 'blobs';
const VERSION = 1;

export interface BlobCache {
	get(id: string): Promise<Bytes | null>;
	put(id: string, bytes: Bytes): Promise<void>;
	delete(id: string): Promise<void>;
	clear(): Promise<void>;
	/** Bytes held, or null when the store cannot say. */
	size(): Promise<number | null>;
}

/** A cache over IndexedDB; one connection, opened on first use. */
export class IndexedDbCache implements BlobCache {
	private db: Promise<IDBDatabase | null> | null = null;

	constructor(private readonly factory: () => IDBFactory | undefined) {}

	async get(id: string): Promise<Bytes | null> {
		const found = await this.run('readonly', (store) => store.get(id));
		return found instanceof Uint8Array ? new Uint8Array(found) : null;
	}

	async put(id: string, bytes: Bytes): Promise<void> {
		await this.run('readwrite', (store) => store.put(new Uint8Array(bytes), id));
	}

	async delete(id: string): Promise<void> {
		await this.run('readwrite', (store) => store.delete(id));
	}

	async clear(): Promise<void> {
		await this.run('readwrite', (store) => store.clear());
	}

	/**
	 * The entries summed, walking the store. The origin's storage estimate
	 * would be cheaper, but it counts whatever else the host has stored,
	 * every archive that ever lived on it included.
	 */
	async size(): Promise<number | null> {
		const db = await this.open();
		if (db === null) return null;
		try {
			return await new Promise<number>((resolve, reject) => {
				let total = 0;
				const request = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const cursor = request.result;
					if (cursor === null) return resolve(total);
					if (cursor.value instanceof Uint8Array) total += cursor.value.byteLength;
					cursor.continue();
				};
			});
		} catch {
			return null;
		}
	}

	private open(): Promise<IDBDatabase | null> {
		this.db ??= new Promise((resolve) => {
			let factory: IDBFactory | undefined;
			try {
				factory = this.factory();
			} catch {
				factory = undefined;
			}
			if (factory === undefined) return resolve(null);
			try {
				const request = factory.open(DB, VERSION);
				request.onupgradeneeded = () => request.result.createObjectStore(STORE);
				request.onerror = () => resolve(null);
				request.onblocked = () => resolve(null);
				request.onsuccess = () => {
					const db = request.result;
					// Another tab upgrading the schema closes this connection.
					db.onversionchange = () => {
						db.close();
						this.db = null;
					};
					resolve(db);
				};
			} catch {
				resolve(null);
			}
		});
		return this.db;
	}

	private async run<T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore) => IDBRequest<T>
	): Promise<T | null> {
		const db = await this.open();
		if (db === null) return null;
		try {
			return await new Promise<T>((resolve, reject) => {
				const request = operation(db.transaction(STORE, mode).objectStore(STORE));
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve(request.result);
			});
		} catch {
			return null;
		}
	}
}

/** A cache for tests and for code paths that want none. */
export class MemoryCache implements BlobCache {
	readonly entries = new Map<string, Bytes>();

	get(id: string): Promise<Bytes | null> {
		const found = this.entries.get(id);
		return Promise.resolve(found === undefined ? null : new Uint8Array(found));
	}

	put(id: string, bytes: Bytes): Promise<void> {
		this.entries.set(id, new Uint8Array(bytes));
		return Promise.resolve();
	}

	delete(id: string): Promise<void> {
		this.entries.delete(id);
		return Promise.resolve();
	}

	clear(): Promise<void> {
		this.entries.clear();
		return Promise.resolve();
	}

	size(): Promise<number | null> {
		let total = 0;
		for (const bytes of this.entries.values()) total += bytes.byteLength;
		return Promise.resolve(total);
	}
}

export const blobCache: BlobCache = new IndexedDbCache(() =>
	typeof indexedDB === 'undefined' ? undefined : indexedDB
);
