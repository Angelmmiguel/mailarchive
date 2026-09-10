import { beforeEach, describe, expect, it } from 'vitest';
import type { SegmentRef } from '$lib/crypto/manifest';
import type { IndexRecord } from '$lib/index/records';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import { findUnreferenced, IndexIncompleteError, unreferencedListing } from './unreferenced';

let api: MockApi;
let account: TestAccount;

const hex = (c: string): string => c.repeat(64);
const SEGMENT: SegmentRef = { id: hex('a'), createdAt: 't', messages: 1, shards: [hex('b')] };

function record(id: string, view: string): IndexRecord {
	return {
		id,
		messageId: null,
		threadId: id,
		date: null,
		from: null,
		to: [],
		cc: [],
		subject: '',
		snippet: '',
		size: 1,
		attachments: [],
		view
	};
}

beforeEach(() => {
	session.lock();
	index.clear();
	api = mockApi();
	account = createTestAccount();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { ...account.body, segments: [SEGMENT] },
		etag: '"v1"'
	});
	api.getManifest.mockResolvedValue({ data: account.manifest, etag: '"v1"' });
});

describe('findUnreferenced', () => {
	it('leaves out every segment, shard, original and view the archive points to', async () => {
		index.add(SEGMENT.id, [record(hex('c'), hex('d'))]);
		api.listBlobs.mockResolvedValue([hex('e'), hex('d'), hex('c'), hex('b'), hex('a'), hex('0')]);

		expect(await findUnreferenced({ api })).toEqual([hex('0'), hex('e')]);
	});

	it('refuses while the index does not hold every segment of the manifest', async () => {
		await expect(findUnreferenced({ api })).rejects.toThrow(IndexIncompleteError);
		expect(api.listBlobs).not.toHaveBeenCalled();
	});

	it('needs an unlocked session', async () => {
		session.lock();
		await expect(findUnreferenced({ api })).rejects.toThrow(LockedError);
	});
});

describe('unreferencedListing', () => {
	it('is one path per line, laid out as the store keeps blobs', () => {
		expect(unreferencedListing([hex('0'), 'ab' + 'c'.repeat(62)])).toBe(
			`blobs/00/${hex('0')}\nblobs/ab/ab${'c'.repeat(62)}\n`
		);
		expect(unreferencedListing([])).toBe('');
	});
});
