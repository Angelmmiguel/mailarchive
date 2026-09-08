import { describe, expect, it } from 'vitest';
import { INDEX_VERSION, type IndexRecord } from '$lib/index/records';
import { TermIndex } from '$lib/index/terms';
import { groupThreads } from '$lib/index/threads';
import { FIELD_BODY, FIELD_SUBJECT } from '$lib/mail/tokenize';
import { parseQuery } from './query';
import { search } from './search';

const OWN = ['me@example.org'];

function record(over: Partial<IndexRecord> & { id: string }): IndexRecord {
	return {
		messageId: `${over.id}@x`,
		threadId: over.id,
		date: '2026-09-01T10:00:00Z',
		from: { name: 'Jane Okafor', address: 'j.okafor@acme.co' },
		to: [{ name: '', address: 'me@example.org' }],
		cc: [],
		subject: '',
		snippet: '',
		size: 1,
		attachments: [],
		view: 'v',
		...over
	};
}

const records = [
	record({
		id: 'invoice',
		subject: 'Invoice #4471 overdue',
		snippet: 'Second reminder, payment terms were net 30.',
		attachments: [
			{ name: 'invoice.pdf', type: 'application/pdf', size: 1, inline: false, index: 0 }
		],
		date: '2026-09-03T10:00:00Z'
	}),
	record({
		id: 'contracts',
		subject: 'Re: Q3 vendor contracts',
		snippet: 'Countersigned agreements attached.',
		from: { name: 'Legal', address: 'legal@acme.co' },
		date: '2026-09-02T10:00:00Z'
	}),
	record({
		id: 'contracts-signed',
		threadId: 'contracts',
		subject: 'Re: Q3 vendor contracts',
		snippet: 'Signed. Sending to you both.',
		from: { name: '', address: 'me@example.org' },
		to: [{ name: 'Legal', address: 'legal@acme.co' }],
		attachments: [
			{ name: 'signed.pdf', type: 'application/pdf', size: 1, inline: false, index: 0 }
		],
		date: '2026-09-02T12:00:00Z'
	}),
	record({
		id: 'deck',
		subject: 'Board deck v3',
		snippet: 'Updated the runway slide.',
		from: { name: '', address: 'me@example.org' },
		to: [{ name: 'D. Reyes', address: 'd.reyes@acme.co' }],
		date: '2026-08-01T10:00:00Z'
	}),
	record({ id: 'undated', subject: 'Photos', date: null })
];
const threads = groupThreads(records, OWN);

function terms(): TermIndex {
	const index = new TermIndex();
	index.add({
		version: INDEX_VERSION,
		prefix: 'x',
		terms: {
			runway: [
				['deck', FIELD_SUBJECT, 1],
				['contracts', FIELD_BODY, 2]
			],
			statement: [['invoice', FIELD_BODY, 1]]
		}
	});
	return index;
}

const ids = (
	query: string,
	order?: 'best' | 'newest' | 'oldest',
	index: TermIndex | null = terms()
) => search(threads, parseQuery(query), OWN, index, order).map((s) => s.thread.id);

describe('search', () => {
	it('keeps every thread in list order for an empty query', () => {
		expect(ids('')).toEqual(['invoice', 'contracts', 'deck', 'undated']);
		expect(ids('', 'oldest')).toEqual(['deck', 'contracts', 'invoice', 'undated']);
	});

	it('matches word prefixes in subject, names, snippet and body', () => {
		expect(ids('inv')).toEqual(['invoice']);
		expect(ids('okaf')).toEqual(['invoice', 'undated']);
		expect(ids('legal')).toEqual(['contracts']);
		expect(ids('reminder')).toEqual(['invoice']);
		expect(ids('statement')).toEqual(['invoice']);
		expect(ids('statement', 'best', null)).toEqual([]);
		expect(ids('invoice overdue')).toEqual(['invoice']);
		expect(ids('invoice deck')).toEqual([]);
	});

	it('ranks subject hits above body hits and falls back to date order when asked', () => {
		expect(ids('runway')).toEqual(['deck', 'contracts']);
		expect(ids('runway', 'newest')).toEqual(['contracts', 'deck']);
		const scored = search(threads, parseQuery('runway'), OWN, terms());
		expect(scored[0].score).toBeGreaterThan(scored[1].score);
	});

	it('applies operators', () => {
		expect(ids('from:okafor')).toEqual(['invoice', 'undated']);
		expect(ids('from:me')).toEqual(['contracts', 'deck']);
		expect(ids('to:me')).toEqual(['invoice', 'contracts', 'undated']);
		expect(ids('to:reyes')).toEqual(['deck']);
		expect(ids('subject:"vendor contracts"')).toEqual(['contracts']);
		expect(ids('has:attachment')).toEqual(['invoice', 'contracts']);
		expect(ids('is:sent')).toEqual(['contracts', 'deck']);
		expect(ids('after:2026-09')).toEqual(['invoice', 'contracts']);
		expect(ids('before:2026-09-03')).toEqual(['contracts', 'deck']);
		expect(ids('after:2026-09-02 before:2026-09-03')).toEqual(['contracts']);
		expect(ids('after:2026-09-02 before:2026-09-03')).toEqual(['contracts']);
	});

	it('lets the parts of a query hold on different messages of a thread', () => {
		expect(ids('from:legal has:attachment')).toEqual(['contracts']);
		expect(ids('from:legal runway signed')).toEqual(['contracts']);
		expect(ids('from:legal -signed')).toEqual([]);
	});

	it('matches phrases and drops exclusions', () => {
		expect(ids('"net 30"')).toEqual(['invoice']);
		expect(ids('"30 net"')).toEqual([]);
		expect(ids('"runway"')).toEqual(['deck', 'contracts']);
		// A body phrase needs whole terms; the snippet still matches as text.
		expect(ids('"runwa"')).toEqual(['deck']);
		expect(ids('okafor -invoice')).toEqual(['undated']);
		expect(ids('-statement')).toEqual(['contracts', 'deck', 'undated']);
	});
});
