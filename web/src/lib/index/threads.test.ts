import { describe, expect, it } from 'vitest';
import type { IndexRecord } from './records';
import {
	groupThreads,
	NO_SUBJECT,
	participantsOf,
	shortName,
	THREAD_KEY,
	threadKey
} from './threads';

function record(id: string, extra: Partial<IndexRecord> = {}): IndexRecord {
	return {
		id,
		messageId: `${id}@x`,
		threadId: 'root@x',
		date: '2026-09-02T09:00:00.000Z',
		from: { name: '', address: 'legal@acme.co' },
		to: [{ name: 'Maren Okafor', address: 'me@example.com' }],
		cc: [],
		subject: 'Q3 vendor contracts',
		snippet: '',
		size: 1,
		attachments: [],
		view: 'v',
		...extra
	};
}

const OWN = ['me@example.com'];

describe('groupThreads', () => {
	it('groups by thread id, oldest message first and newest thread first', () => {
		const threads = groupThreads(
			[
				record('b', { date: '2026-09-03T00:00:00.000Z', subject: 'Re: Q3 vendor contracts' }),
				record('a', { date: '2026-09-01T00:00:00.000Z' }),
				record('c', { threadId: 'other@x', date: '2026-09-04T00:00:00.000Z', subject: 'Photos' }),
				record('d', { threadId: 'old@x', date: '2026-08-01T00:00:00.000Z', subject: 'Old' })
			],
			OWN
		);

		expect(threads.map((t) => t.id)).toEqual(['other@x', 'root@x', 'old@x']);
		expect(threads[1].messages.map((m) => m.id)).toEqual(['a', 'b']);
		expect(threads[1].latest.id).toBe('b');
		expect(threads[1].subject).toBe('Re: Q3 vendor contracts');
	});

	it('puts undated messages and threads last, and falls back for the subject', () => {
		const threads = groupThreads(
			[
				record('u', { date: null, subject: '' }),
				record('a', { date: '2026-09-01T00:00:00.000Z' }),
				record('n', { threadId: 'nodate@x', date: null, subject: '' })
			],
			OWN
		);

		expect(threads.map((t) => t.id)).toEqual(['root@x', 'nodate@x']);
		expect(threads[0].messages.map((m) => m.id)).toEqual(['a', 'u']);
		expect(threads[0].latest.id).toBe('a');
		expect(threads[1].subject).toBe(NO_SUBJECT);
	});

	it('counts non-inline attachments and labels the messages in a fixed order', () => {
		const [thread] = groupThreads(
			[
				record('a', {
					attachments: [
						{ name: 'a.pdf', type: 'application/pdf', size: 1, inline: false, index: 0 },
						{ name: 'logo.png', type: 'image/png', size: 1, inline: true, index: 1 }
					]
				}),
				record('b', {
					from: { name: '', address: 'me@example.com' },
					date: '2026-09-03T00:00:00.000Z'
				})
			],
			OWN
		);

		expect(thread.attachments).toBe(1);
		expect(thread.labels).toEqual(['sent', 'attachments']);
	});

	it('orders threads with the same date by id', () => {
		const threads = groupThreads(
			[record('a', { threadId: 'b@x' }), record('b', { threadId: 'a@x' })],
			OWN
		);

		expect(threads.map((t) => t.id)).toEqual(['a@x', 'b@x']);
	});
});

describe('participantsOf', () => {
	it('lists senders once each, in order, with the user as me', () => {
		const [thread] = groupThreads(
			[
				record('a', { date: '2026-09-01T00:00:00.000Z' }),
				record('b', {
					date: '2026-09-02T00:00:00.000Z',
					from: { name: 'Maren Okafor', address: 'ME@example.com' }
				}),
				record('c', { date: '2026-09-03T00:00:00.000Z' }),
				record('d', {
					date: '2026-09-04T00:00:00.000Z',
					from: { name: 'Finance', address: 'f@acme.co' }
				})
			],
			OWN
		);

		expect(participantsOf(thread, OWN)).toBe('legal, me, Finance');
	});

	it('names the recipients of a thread the user alone wrote', () => {
		const [thread] = groupThreads(
			[
				record('a', {
					from: { name: '', address: 'me@example.com' },
					to: [{ name: '', address: 'd.reyes@acme.co' }],
					cc: [{ name: '', address: 'me@example.com' }]
				})
			],
			OWN
		);

		expect(participantsOf(thread, OWN)).toBe('to d.reyes');
		expect(participantsOf(thread, [])).toBe('me');
	});

	it('says unknown for a message without a sender', () => {
		const [thread] = groupThreads([record('a', { from: null })], OWN);

		expect(participantsOf(thread, OWN)).toBe('unknown');
	});
});

describe('shortName', () => {
	it('prefers the display name and falls back to the local part', () => {
		expect(shortName({ name: ' Ineffable Roasters ', address: 'x@y' })).toBe('Ineffable Roasters');
		expect(shortName({ name: '', address: 'j.okafor@acme.co' })).toBe('j.okafor');
		expect(shortName({ name: '', address: 'nowhere' })).toBe('nowhere');
	});
});

describe('threadKey', () => {
	it('derives a stable opaque name that changes with the key and the id', () => {
		const key = new Uint8Array(32).fill(1);
		const one = threadKey(key, 'root@x');

		expect(one).toMatch(THREAD_KEY);
		expect(threadKey(key, 'root@x')).toBe(one);
		expect(threadKey(key, 'other@x')).not.toBe(one);
		expect(threadKey(new Uint8Array(32).fill(2), 'root@x')).not.toBe(one);
	});
});
