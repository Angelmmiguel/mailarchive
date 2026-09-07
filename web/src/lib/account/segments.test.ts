import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type Bytes } from '$lib/api/types';
import { deriveSubkeys } from '$lib/crypto/keys';
import { decodeManifestBody, encodeManifest, type SegmentRef } from '$lib/crypto/manifest';
import { MemoryCache } from '$lib/cache/blobs';
import { encodeSegmentIndex, encodeShard, groupShards } from '$lib/index/segment';
import { terms } from '$lib/state/terms.svelte';
import type { IndexRecord } from '$lib/index/records';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import {
	commitSegment,
	MissingSegmentError,
	MissingShardError,
	openIndex,
	openTerms
} from './segments';

let api: MockApi;
let account: TestAccount;
let cache: MemoryCache;

function record(id: string): IndexRecord {
	return {
		id,
		messageId: `${id}@x`,
		threadId: `${id}@x`,
		date: null,
		from: null,
		to: [],
		cc: [],
		subject: id,
		snippet: '',
		labels: [],
		size: 1,
		attachments: [],
		view: 'v'
	};
}

function unlockWith(segments: SegmentRef[]): void {
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { ...account.body, segments },
		etag: '"v1"'
	});
}

beforeEach(() => {
	session.lock();
	index.clear();
	terms.clear();
	cache = new MemoryCache();
	api = mockApi();
	account = createTestAccount();
});

describe('openIndex', () => {
	it('fetches, decrypts and merges every segment not yet loaded', async () => {
		const keys = deriveSubkeys(account.dek);
		const one = await encodeSegmentIndex(keys, [record('a')]);
		const two = await encodeSegmentIndex(keys, [record('b'), record('c')]);
		unlockWith([
			{ id: one.id, createdAt: '', messages: 1, shards: [] },
			{ id: two.id, createdAt: '', messages: 2, shards: [] }
		]);
		api.getBlob.mockImplementation((id) =>
			Promise.resolve(id === one.id ? one.sealed : id === two.id ? two.sealed : null)
		);

		await openIndex({ api, cache });

		expect(index.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(index.loading).toBeNull();

		await openIndex({ api, cache });
		expect(api.getBlob).toHaveBeenCalledTimes(2);
	});

	it('reports a segment the server lost after reading the rest', async () => {
		const keys = deriveSubkeys(account.dek);
		const one = await encodeSegmentIndex(keys, [record('a')]);
		unlockWith([
			{ id: 'e'.repeat(64), createdAt: '', messages: 1, shards: [] },
			{ id: one.id, createdAt: '', messages: 1, shards: [] }
		]);
		api.getBlob.mockImplementation((id) => Promise.resolve(id === one.id ? one.sealed : null));

		await expect(openIndex({ api, cache })).rejects.toThrow(MissingSegmentError);
		expect(index.messages).toBe(1);
		expect(index.loading).toBeNull();
	});

	it('needs an unlocked session', async () => {
		await expect(openIndex({ api, cache })).rejects.toThrow(LockedError);
	});

	it('reads a segment from the cache and caches what it fetched', async () => {
		const keys = deriveSubkeys(account.dek);
		const one = await encodeSegmentIndex(keys, [record('a')]);
		const two = await encodeSegmentIndex(keys, [record('b')]);
		await cache.put(one.id, one.sealed);
		unlockWith([
			{ id: one.id, createdAt: '', messages: 1, shards: [] },
			{ id: two.id, createdAt: '', messages: 1, shards: [] }
		]);
		api.getBlob.mockImplementation((id) => Promise.resolve(id === two.id ? two.sealed : null));

		await openIndex({ api, cache });

		expect(index.records.map((r) => r.id)).toEqual(['a', 'b']);
		expect(api.getBlob).toHaveBeenCalledTimes(1);
		expect(api.getBlob).toHaveBeenCalledWith(two.id);
		expect(await cache.get(two.id)).toEqual(two.sealed);
	});

	it('drops a cached copy that does not decrypt and fetches the blob again', async () => {
		const keys = deriveSubkeys(account.dek);
		const one = await encodeSegmentIndex(keys, [record('a')]);
		const corrupt = new Uint8Array(one.sealed);
		corrupt[corrupt.length - 1] ^= 1;
		await cache.put(one.id, corrupt);
		unlockWith([{ id: one.id, createdAt: '', messages: 1, shards: [] }]);
		api.getBlob.mockResolvedValue(one.sealed);

		await openIndex({ api, cache });

		expect(index.records.map((r) => r.id)).toEqual(['a']);
		expect(await cache.get(one.id)).toEqual(one.sealed);
	});
});

describe('openTerms', () => {
	async function segmentWithShards(ids: string[]) {
		const keys = deriveSubkeys(account.dek);
		const records = ids.map(record);
		const indexBlob = await encodeSegmentIndex(keys, records);
		const shards = groupShards(
			indexBlob.id,
			keys,
			ids.map((id) => ({ id, terms: [{ term: `term${id}`, field: 4, frequency: 1 }] }))
		);
		const sealed = new Map<string, Bytes>();
		for (const [id, shard] of shards) sealed.set(id, (await encodeShard(keys, id, shard)).sealed);
		const ref: SegmentRef = {
			id: indexBlob.id,
			createdAt: '',
			messages: ids.length,
			shards: [...shards.keys()]
		};
		return { ref, records, sealed };
	}

	it('loads the shards of the segments the index holds, through the cache', async () => {
		const one = await segmentWithShards(['a', 'b']);
		const two = await segmentWithShards(['c']);
		unlockWith([one.ref, two.ref]);
		index.add(one.ref.id, one.records);
		api.getBlob.mockImplementation((id) => Promise.resolve(one.sealed.get(id) ?? null));

		await openTerms({ api, cache });

		expect(terms.segments).toEqual(new Set([one.ref.id]));
		expect(terms.index.lookup('terma')).toHaveLength(1);
		expect(terms.index.lookup('termc')).toHaveLength(0);
		expect(terms.loading).toBeNull();
		for (const id of one.ref.shards) expect(await cache.get(id)).toEqual(one.sealed.get(id));

		// The second segment's shards come once its index is in, from the cache this time.
		for (const [id, bytes] of two.sealed) await cache.put(id, bytes);
		api.getBlob.mockClear();
		index.add(two.ref.id, two.records);
		await openTerms({ api, cache });
		expect(terms.index.lookup('termc')).toHaveLength(1);
		expect(api.getBlob).not.toHaveBeenCalled();
	});

	it('leaves a segment out whole when one of its shards is lost', async () => {
		const one = await segmentWithShards(['a', 'b']);
		unlockWith([one.ref]);
		index.add(one.ref.id, one.records);
		const [lost] = one.ref.shards;
		api.getBlob.mockImplementation((id) =>
			Promise.resolve(id === lost ? null : (one.sealed.get(id) ?? null))
		);

		await expect(openTerms({ api, cache })).rejects.toThrow(MissingShardError);
		expect(terms.segments.size).toBe(0);
		expect(terms.loading).toBeNull();
	});

	it('runs calls one after another, each seeing the segments added meanwhile', async () => {
		const one = await segmentWithShards(['a']);
		const two = await segmentWithShards(['b']);
		unlockWith([one.ref, two.ref]);
		index.add(one.ref.id, one.records);
		api.getBlob.mockImplementation(
			(id) =>
				new Promise((resolve) =>
					setTimeout(() => resolve(one.sealed.get(id) ?? two.sealed.get(id) ?? null), 5)
				)
		);

		const first = openTerms({ api, cache });
		await new Promise((r) => setTimeout(r, 0));
		index.add(two.ref.id, two.records);
		const second = openTerms({ api, cache });
		await first;
		expect(terms.segments).toEqual(new Set([one.ref.id]));
		await second;
		expect(terms.segments).toEqual(new Set([one.ref.id, two.ref.id]));
	});

	it('stops at a lock without touching the cache or the index', async () => {
		const one = await segmentWithShards(['a']);
		unlockWith([one.ref]);
		index.add(one.ref.id, one.records);
		api.getBlob.mockImplementation(
			(id) => new Promise((resolve) => setTimeout(() => resolve(one.sealed.get(id) ?? null), 5))
		);

		const run = openTerms({ api, cache });
		session.lock();
		await expect(run).rejects.toThrow(LockedError);
		expect(terms.segments.size).toBe(0);
		expect(terms.index.size).toBe(0);
		expect(await cache.get(one.ref.shards[0])).toBeNull();
	});

	it('does not evict a cached copy it cannot open after a lock', async () => {
		const one = await segmentWithShards(['a']);
		unlockWith([one.ref]);
		index.add(one.ref.id, one.records);
		for (const [id, bytes] of one.sealed) await cache.put(id, bytes);
		const slow = new MemoryCache();
		slow.get = async (id) => {
			session.lock();
			return cache.get(id);
		};

		await expect(openTerms({ api, cache: slow })).rejects.toThrow(LockedError);
		for (const id of one.ref.shards) expect(await cache.get(id)).not.toBeNull();
	});
});

describe('commitSegment', () => {
	const segment: SegmentRef = { id: 'a'.repeat(64), createdAt: 't', messages: 2, shards: ['s'] };

	it('appends the segment under the ETag', async () => {
		unlockWith([]);
		api.putManifest.mockResolvedValue({ etag: '"v2"' });

		await commitSegment(segment, { api });

		const [data, ifMatch] = api.putManifest.mock.calls[0]!;
		expect(ifMatch).toBe('"v1"');
		expect(decodeManifestBody(data, deriveSubkeys(account.dek).manifest).segments).toEqual([
			segment
		]);
		expect(session.manifest?.etag).toBe('"v2"');
		expect(session.manifest?.body.segments).toEqual([segment]);
	});

	it('merges with what another device wrote on a conflict', async () => {
		unlockWith([]);
		const theirs: SegmentRef = { id: 'b'.repeat(64), createdAt: 't', messages: 1, shards: [] };
		const keys = deriveSubkeys(account.dek);
		api.putManifest
			.mockRejectedValueOnce(new ApiError(412, 'conflict'))
			.mockResolvedValueOnce({ etag: '"v3"' });
		api.getManifest.mockResolvedValue({
			data: encodeManifest(
				{ header: account.header, body: { ...account.body, segments: [theirs] } },
				keys.manifest
			),
			etag: '"v2"'
		});

		await commitSegment(segment, { api });

		expect(api.putManifest).toHaveBeenCalledTimes(2);
		const [data, ifMatch] = api.putManifest.mock.calls[1]!;
		expect(ifMatch).toBe('"v2"');
		expect(decodeManifestBody(data, keys.manifest).segments).toEqual([theirs, segment]);
	});

	it('gives up after repeated conflicts', async () => {
		unlockWith([]);
		api.putManifest.mockRejectedValue(new ApiError(412, 'conflict'));
		api.getManifest.mockResolvedValue({ data: account.manifest, etag: '"v1"' });

		await expect(commitSegment(segment, { api })).rejects.toThrow(ApiError);
		expect(api.putManifest).toHaveBeenCalledTimes(3);
	});
});
