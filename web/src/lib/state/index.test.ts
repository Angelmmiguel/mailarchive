import { beforeEach, describe, expect, it } from 'vitest';
import type { IndexRecord } from '$lib/index/records';
import { index } from './index.svelte';

function record(id: string, extra: Partial<IndexRecord> = {}): IndexRecord {
	return {
		id,
		messageId: `${id}@x`,
		threadId: `${id}@x`,
		date: '2026-09-06T09:12:32.000Z',
		from: { name: '', address: 'a@x' },
		to: [],
		cc: [],
		subject: '',
		snippet: '',
		labels: [],
		size: 1,
		attachments: [],
		view: 'v',
		...extra
	};
}

beforeEach(() => index.clear());

describe('add', () => {
	it('merges segments and skips records already present', () => {
		index.add('s1', [record('a'), record('b')]);
		index.add('s2', [record('b'), record('c')]);

		expect(index.messages).toBe(3);
		expect(index.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect([...index.segments]).toEqual(['s1', 's2']);
	});
});

describe('find', () => {
	it('finds by raw id, or by Message-ID with the same date and sender', () => {
		index.add('s1', [record('a')]);

		expect(index.find({ id: 'a', messageId: null, date: null, from: null })?.id).toBe('a');
		const reexport = {
			id: 'other',
			messageId: 'a@x',
			date: '2026-09-06T09:12:32.000Z',
			from: { address: 'a@x' }
		};
		expect(index.find(reexport)?.id).toBe('a');
		expect(index.find({ ...reexport, date: '2026-09-07T00:00:00.000Z' })).toBeNull();
		expect(index.find({ ...reexport, from: { address: 'b@x' } })).toBeNull();
		expect(index.find({ ...reexport, messageId: null })).toBeNull();
	});
});

describe('threadMap', () => {
	it('maps Message-ID headers to threads', () => {
		index.add('s1', [record('a', { threadId: 'root@x' })]);

		expect(index.threadMap().get('a@x')).toBe('root@x');
	});
});
