import { beforeEach, describe, expect, it } from 'vitest';
import { deriveSubkeys } from '$lib/crypto/keys';
import { encodeManifest, type SegmentRef } from '$lib/crypto/manifest';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import { checkForSegments } from './sync';

let api: MockApi;
let account: TestAccount;

const segment = (id: string): SegmentRef => ({
	id: id.repeat(64),
	createdAt: '2026-09-07T00:00:00Z',
	messages: 1,
	shards: []
});

beforeEach(() => {
	session.lock();
	api = mockApi();
	account = createTestAccount();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { ...account.body, segments: [segment('a')] },
		etag: '"v1"'
	});
});

describe('checkForSegments', () => {
	it('does nothing while the ETag is the one held', async () => {
		api.getManifest.mockResolvedValue({ data: account.manifest, etag: '"v1"' });

		expect(await checkForSegments({ api })).toBe(0);
		expect(session.manifest?.etag).toBe('"v1"');
	});

	it('adopts a newer manifest and counts the segments it adds', async () => {
		const keys = deriveSubkeys(account.dek);
		const body = { ...account.body, segments: [segment('a'), segment('b'), segment('c')] };
		api.getManifest.mockResolvedValue({
			data: encodeManifest({ header: account.header, body }, keys.manifest),
			etag: '"v2"'
		});

		expect(await checkForSegments({ api })).toBe(2);
		expect(session.manifest?.etag).toBe('"v2"');
		expect(session.manifest?.body.segments.map((s) => s.id[0])).toEqual(['a', 'b', 'c']);
	});

	it('refuses while locked', async () => {
		session.lock();

		await expect(checkForSegments({ api })).rejects.toThrow(LockedError);
	});
});
