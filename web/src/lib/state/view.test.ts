import { beforeEach, describe, expect, it } from 'vitest';
import { LockedError } from '$lib/account/errors';
import type { IndexRecord } from '$lib/index/records';
import { THREAD_KEY } from '$lib/index/threads';
import { createTestAccount } from '$lib/testing/account';
import { importState } from './import.svelte';
import { index } from './index.svelte';
import { session } from './session.svelte';
import { view } from './view.svelte';

function record(id: string, extra: Partial<IndexRecord> = {}): IndexRecord {
	return {
		id,
		messageId: `${id}@x`,
		threadId: `${id}@x`,
		date: '2026-09-06T09:12:32.000Z',
		from: { name: '', address: 'a@x' },
		to: [],
		cc: [],
		subject: id,
		snippet: '',
		labels: [],
		size: 1,
		attachments: [],
		view: 'v',
		...extra
	};
}

const account = createTestAccount();

beforeEach(() => {
	session.lock();
	index.clear();
	importState.reset();
	view.reset();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { ...account.body, segments: [] },
		etag: '"v1"'
	});
});

describe('listing', () => {
	it('follows the index and the filters', () => {
		index.add('s1', [record('a', { labels: ['sent'] }), record('b')]);

		expect(view.listing.map((t) => t.id)).toEqual(['a@x', 'b@x']);
		view.filters = { sent: true, attachments: false };
		expect(view.listing.map((t) => t.id)).toEqual(['a@x']);
	});
});

describe('keys', () => {
	it('names threads opaquely and finds them back by name', () => {
		index.add('s1', [record('a'), record('b')]);
		const key = view.keyFor('a@x');

		expect(key).toMatch(THREAD_KEY);
		expect(view.threadFor(key)?.id).toBe('a@x');
		expect(view.threadFor(view.keyFor('b@x'))?.id).toBe('b@x');
		expect(view.threadFor('0'.repeat(64))).toBeNull();
	});

	it('finds a thread by name before any key was asked for', () => {
		index.add('s1', [record('a')]);
		const key = view.keyFor('a@x');
		view.reset();

		expect(view.threadFor(key)?.id).toBe('a@x');
	});

	it('needs the keys', () => {
		session.lock();

		expect(() => view.keyFor('a@x')).toThrow(LockedError);
	});
});

describe('pendingSegments', () => {
	it('counts manifest segments the index has not loaded, except during an import', () => {
		const segment = { id: 'f'.repeat(64), createdAt: '', messages: 1, shards: [] };
		session.manifest = { ...session.manifest!, body: { ...account.body, segments: [segment] } };

		expect(view.pendingSegments).toBe(1);
		importState.begin('x', 1);
		expect(view.pendingSegments).toBe(0);
		importState.reset();
		index.add(segment.id, [record('a')]);
		expect(view.pendingSegments).toBe(0);
	});
});
