import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbCache, MemoryCache, type BlobCache } from './blobs';

const bytes = (...b: number[]) => new Uint8Array(b);

function behaves(name: string, make: () => BlobCache): void {
	describe(name, () => {
		it('stores, lists, deletes and clears blobs by id', async () => {
			const cache = make();
			expect(await cache.get('a')).toBeNull();
			await cache.put('a', bytes(1, 2, 3));
			await cache.put('b', bytes(4));
			expect(await cache.get('a')).toEqual(bytes(1, 2, 3));
			expect(await cache.get('b')).toEqual(bytes(4));
			await cache.delete('a');
			expect(await cache.get('a')).toBeNull();
			await cache.clear();
			expect(await cache.get('b')).toBeNull();
		});

		it('hands out copies', async () => {
			const cache = make();
			const original = bytes(9);
			await cache.put('a', original);
			original[0] = 0;
			const read = await cache.get('a');
			expect(read).toEqual(bytes(9));
			read![0] = 1;
			expect(await cache.get('a')).toEqual(bytes(9));
		});
	});
}

behaves('IndexedDbCache', () => new IndexedDbCache(() => new IDBFactory()));
behaves('MemoryCache', () => new MemoryCache());

describe('IndexedDbCache without IndexedDB', () => {
	it('answers every call as a miss', async () => {
		const cache = new IndexedDbCache(() => undefined);
		await cache.put('a', bytes(1));
		expect(await cache.get('a')).toBeNull();
		await expect(cache.clear()).resolves.toBeUndefined();
	});

	it('survives a factory that throws', async () => {
		const cache = new IndexedDbCache(() => {
			throw new Error('SecurityError');
		});
		expect(await cache.get('a')).toBeNull();
	});
});
