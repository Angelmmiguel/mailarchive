import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import { deriveSubkeys } from '$lib/crypto/keys';
import { decodeManifestBody, encodeManifest, type SegmentRef } from '$lib/crypto/manifest';
import { encodeSegmentIndex } from '$lib/index/segment';
import type { IndexRecord } from '$lib/index/records';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import { commitSegment, MissingSegmentError, openIndex } from './segments';

let api: MockApi;
let account: TestAccount;

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

		await openIndex({ api });

		expect(index.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(index.loading).toBeNull();

		await openIndex({ api });
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

		await expect(openIndex({ api })).rejects.toThrow(MissingSegmentError);
		expect(index.messages).toBe(1);
		expect(index.loading).toBeNull();
	});

	it('needs an unlocked session', async () => {
		await expect(openIndex({ api })).rejects.toThrow(LockedError);
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
