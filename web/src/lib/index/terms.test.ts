import { describe, expect, it } from 'vitest';
import { FIELD_BODY, FIELD_SUBJECT } from '$lib/mail/tokenize';
import { INDEX_VERSION, type TermShard } from './records';
import { MAX_EXPANSION, TermIndex } from './terms';

function shard(terms: TermShard['terms']): TermShard {
	return { version: INDEX_VERSION, prefix: 'i', terms };
}

describe('TermIndex', () => {
	it('merges shards and expands a prefix to every term under it, exact first', () => {
		const index = new TermIndex();
		index.add(shard({ invoice: [['a', FIELD_SUBJECT, 1]], invoices: [['b', FIELD_BODY, 2]] }));
		index.add(shard({ invoice: [['c', FIELD_BODY, 3]], inbox: [['d', FIELD_BODY, 1]] }));
		expect(index.size).toBe(3);
		expect(index.lookup('invoice').map((h) => [h.id, h.term])).toEqual([
			['a', 'invoice'],
			['c', 'invoice'],
			['b', 'invoices']
		]);
		expect(
			index
				.lookup('in')
				.map((h) => h.id)
				.sort()
		).toEqual(['a', 'b', 'c', 'd']);
		expect(
			index
				.lookup('inv')
				.map((h) => h.id)
				.sort()
		).toEqual(['a', 'b', 'c']);
		expect(index.lookup('x')).toEqual([]);
		expect(index.lookup('invoicesx')).toEqual([]);
	});

	it('keeps the order right when shards arrive after a lookup', () => {
		const index = new TermIndex();
		index.add(shard({ beta: [['a', FIELD_BODY, 1]] }));
		expect(index.lookup('b')).toHaveLength(1);
		index.add(shard({ alpha: [['b', FIELD_BODY, 1]], bravo: [['c', FIELD_BODY, 1]] }));
		expect(index.lookup('b').map((h) => h.term)).toEqual(['beta', 'bravo']);
		expect(index.lookup('a').map((h) => h.term)).toEqual(['alpha']);
	});

	it('stops expanding a prefix past the cap', () => {
		const index = new TermIndex();
		const terms: TermShard['terms'] = Object.create(null) as TermShard['terms'];
		for (let i = 0; i < MAX_EXPANSION + 10; i++)
			terms[`t${String(i).padStart(5, '0')}`] = [['m', 4, 1]];
		index.add(shard(terms));
		expect(index.lookup('t')).toHaveLength(MAX_EXPANSION);
	});

	it('clears everything', () => {
		const index = new TermIndex();
		index.add(shard({ a1: [['a', FIELD_BODY, 1]] }));
		index.segments.add('s');
		index.clear();
		expect(index.size).toBe(0);
		expect(index.segments.size).toBe(0);
		expect(index.lookup('a')).toEqual([]);
	});
});
