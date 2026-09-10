import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type Bytes } from '$lib/api/types';
import { MemoryCache } from '$lib/cache/blobs';
import { blobId, encryptBlobAs } from '$lib/crypto/blob';
import { deriveSubkeys } from '$lib/crypto/keys';
import { decodeManifestBody, encodeManifest, type SegmentRef } from '$lib/crypto/manifest';
import { inlineParser } from '$lib/import/parser';
import { prepare } from '$lib/import/prepare';
import type { IndexRecord } from '$lib/index/records';
import { fixture } from '$lib/mail/message.test';
import { importState } from '$lib/state/import.svelte';
import { index } from '$lib/state/index.svelte';
import { rebuildState } from '$lib/state/rebuild.svelte';
import { session } from '$lib/state/session.svelte';
import { terms } from '$lib/state/terms.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import { RebuildBlockedError, rebuildIndex } from './rebuild';

let api: MockApi;
let account: TestAccount;
let cache: MemoryCache;
let blobs: Map<string, Bytes>;

const OLD: SegmentRef = {
	id: 'a'.repeat(64),
	createdAt: '2026-09-01T00:00:00Z',
	messages: 0,
	shards: ['b'.repeat(64)]
};

/** An old record as an earlier import would have frozen it: wrong on purpose. */
function record(id: string, over: Partial<IndexRecord> = {}): IndexRecord {
	return {
		id,
		messageId: null,
		threadId: `old-${id.slice(0, 4)}`,
		date: null,
		from: null,
		to: [],
		cc: [],
		subject: 'stale',
		snippet: '',
		size: 7,
		attachments: [],
		view: 'v'.repeat(64),
		...over
	};
}

/** Stores a fixture as its raw blob and returns the record pointing at it. */
async function stored(name: string, over: Partial<IndexRecord> = {}): Promise<IndexRecord> {
	const bytes = await fixture(name);
	const keys = deriveSubkeys(account.dek);
	const id = blobId(keys.id, bytes);
	blobs.set(id, encryptBlobAs(keys, id, (await prepare(bytes)).raw));
	return record(id, over);
}

function unlockWith(segments: SegmentRef[]): void {
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { settings: { ownAddresses: ['reader@example.org'] }, segments },
		etag: '"v1"'
	});
}

function run(signal = new AbortController().signal) {
	return rebuildIndex({ api, cache, parser: inlineParser(), signal });
}

beforeEach(async () => {
	session.lock();
	index.clear();
	terms.clear();
	importState.reset();
	cache = new MemoryCache();
	api = mockApi();
	account = createTestAccount();
	blobs = new Map();
	api.getBlob.mockImplementation((id) => Promise.resolve(blobs.get(id) ?? null));
	api.headBlob.mockImplementation((id) => Promise.resolve(blobs.has(id)));
	api.putBlob.mockImplementation((id, data) => {
		if (blobs.has(id)) return Promise.resolve('exists');
		blobs.set(id, data);
		return Promise.resolve('created');
	});
	api.putManifest.mockResolvedValue({ etag: '"v2"' });
	unlockWith([OLD]);
	for (const id of [OLD.id, ...OLD.shards]) await cache.put(id, new Uint8Array([1]));
});

describe('rebuildIndex', () => {
	it('parses every original again and swaps the segments in one write', async () => {
		const report = await stored('report.eml');
		const reply = await stored('reply.eml');
		const photos = await stored('photos.eml');
		index.add(OLD.id, [reply, photos, report]);

		const summary = await run();

		expect(summary).toMatchObject({ rebuilt: 3, kept: 0, cancelled: false });
		expect(summary.segments).toHaveLength(1);
		const fresh = summary.segments[0]!;
		expect(api.putManifest).toHaveBeenCalledTimes(1);
		const [data] = api.putManifest.mock.calls[0]!;
		expect(decodeManifestBody(data, deriveSubkeys(account.dek).manifest).segments).toEqual([fresh]);
		expect(session.manifest?.body.segments).toEqual([fresh]);
		expect(session.manifest?.etag).toBe('"v2"');

		const byId = new Map(index.records.map((r) => [r.id, r]));
		expect(index.segments).toEqual(new Set([fresh.id]));
		expect(terms.segments).toEqual(new Set([fresh.id]));
		expect(byId.get(report.id)?.subject).toBe('Your charging summary report is ready');
		expect(byId.get(report.id)?.date).toBe('2026-09-02T07:21:48.000Z');
		expect(byId.get(report.id)?.size).toBe(7);
		expect(byId.get(report.id)?.attachments.map((a) => a.inline)).toEqual([true, false]);
		expect(byId.get(photos.id)?.attachments.map((a) => a.inline)).toEqual([false, false]);
		expect(byId.get(reply.id)?.threadId).toBe(byId.get(report.id)?.threadId);
		expect(byId.get(report.id)?.view).not.toBe('v'.repeat(64));
		expect(blobs.has(byId.get(report.id)!.view)).toBe(true);
		expect(terms.index.lookup('kwh').length).toBeGreaterThan(0);
		expect(await cache.get(OLD.id)).toBeNull();
		expect(await cache.get(fresh.id)).not.toBeNull();
		expect(rebuildState.status).toBe('done');
		expect(rebuildState.done).toBe(3);
	});

	it('reproduces the same segment on a second run and keeps it cached', async () => {
		const report = await stored('report.eml');
		index.add(OLD.id, [report]);
		const first = (await run()).segments[0]!;
		api.putManifest.mockResolvedValue({ etag: '"v3"' });

		const second = (await run()).segments[0]!;

		expect(second.id).toBe(first.id);
		const view = index.records[0]!.view;
		expect(api.putBlob.mock.calls.filter(([id]) => id === view)).toHaveLength(1);
		expect(second.shards).toEqual(first.shards);
		expect(session.manifest?.body.segments).toHaveLength(1);
		expect(await cache.get(first.id)).not.toBeNull();
		for (const id of first.shards) expect(await cache.get(id)).not.toBeNull();
	});

	it('keeps the record of an original the server no longer has', async () => {
		const report = await stored('report.eml');
		const lost = record('c'.repeat(64), { subject: 'Lost', date: '2026-01-01T00:00:00.000Z' });
		index.add(OLD.id, [report, lost]);

		const summary = await run();

		expect(summary).toMatchObject({ rebuilt: 1, kept: 1, cancelled: false });
		const kept = index.records.find((r) => r.id === lost.id);
		expect(kept).toMatchObject({ subject: 'Lost', view: 'v'.repeat(64), size: 7 });
		expect(rebuildState.kept).toBe(1);
	});

	it('keeps a segment another device committed during the run', async () => {
		const report = await stored('report.eml');
		index.add(OLD.id, [report]);
		const theirs: SegmentRef = { id: 'd'.repeat(64), createdAt: 't', messages: 1, shards: [] };
		const keys = deriveSubkeys(account.dek);
		api.putManifest
			.mockRejectedValueOnce(new ApiError(412, 'conflict'))
			.mockResolvedValueOnce({ etag: '"v3"' });
		api.getManifest.mockResolvedValue({
			data: encodeManifest(
				{
					header: account.header,
					body: { settings: { ownAddresses: [] }, segments: [OLD, theirs] }
				},
				keys.manifest
			),
			etag: '"v2"'
		});

		const summary = await run();

		expect(session.manifest?.body.segments).toEqual([theirs, summary.segments[0]]);
	});

	it('leaves the manifest and the index alone when cancelled', async () => {
		const report = await stored('report.eml');
		const reply = await stored('reply.eml');
		index.add(OLD.id, [report, reply]);
		const before = index.records;
		const controller = new AbortController();
		api.getBlob.mockImplementation((id) => {
			controller.abort();
			return Promise.resolve(blobs.get(id) ?? null);
		});

		const summary = await run(controller.signal);

		expect(summary.cancelled).toBe(true);
		expect(api.putManifest).not.toHaveBeenCalled();
		expect(session.manifest?.body.segments).toEqual([OLD]);
		expect(index.records).toBe(before);
		expect(rebuildState.status).toBe('cancelled');
	});

	it('refuses while an import runs or the index is still being read', async () => {
		index.add(OLD.id, []);
		importState.begin('x', 1);
		await expect(run()).rejects.toThrow(RebuildBlockedError);
		importState.reset();

		index.clear();
		await expect(run()).rejects.toThrow(RebuildBlockedError);
	});

	it('stops at a lock and leaves nothing behind', async () => {
		const report = await stored('report.eml');
		index.add(OLD.id, [report]);
		api.getBlob.mockImplementation((id) => {
			const sealed = blobs.get(id) ?? null;
			session.lock();
			return Promise.resolve(sealed);
		});

		await expect(run()).rejects.toThrow(LockedError);
		expect(api.putManifest).not.toHaveBeenCalled();
		expect(rebuildState.status).toBe('cancelled');
	});
});
