import { describe, expect, it } from 'vitest';
import { subjectKey, Threader, type Threadable } from './thread';

const ME = 'me@example.org';
const THEM = { name: 'Them', address: 'them@example.net' };
const OTHER = { name: 'Other', address: 'other@example.com' };

function message(over: Partial<Threadable> = {}): Threadable {
	return {
		messageId: null,
		inReplyTo: null,
		references: [],
		subject: 'Claim',
		date: '2025-09-16T07:40:12.000Z',
		from: THEM,
		to: [{ name: '', address: ME }],
		cc: [],
		...over
	};
}

describe('Threader', () => {
	it('joins the thread of a known ancestor', () => {
		const t = new Threader(
			[ME],
			[{ ...message({ messageId: 'root@x' }), threadId: 'thread-root' }]
		);

		expect(
			t.assign(
				message({ messageId: 'reply@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'] }),
				'f'
			)
		).toBe('thread-root');
	});

	it('names a new thread after the oldest reference, then its own id, then the fallback', () => {
		const t = new Threader([ME]);

		expect(
			t.assign(
				message({ messageId: 'reply@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'] }),
				'f'
			)
		).toBe('root@x');
		expect(t.assign(message({ messageId: 'm@x', subject: 'Other' }), 'f')).toBe('m@x');
		expect(t.assign(message({ subject: 'Another' }), 'f')).toBe('f');
	});

	it('threads a reply with no headers at all by subject and correspondent', () => {
		const t = new Threader([ME]);
		const root = t.assign(message({ messageId: 'root@x', subject: 'TRAMITACIÓN CENTRO' }), 'r');
		const sent = t.assign(
			message({
				subject: 'RE: TRAMITACIÓN  CENTRO',
				date: '2025-09-16T11:13:21.000Z',
				from: { name: '', address: ME },
				to: [THEM]
			}),
			's'
		);
		const theirs = t.assign(
			message({
				messageId: 'theirs@x',
				inReplyTo: 'lost@tuta',
				references: ['lost@tuta'],
				subject: 'RE: TRAMITACIÓN CENTRO',
				date: '2025-09-17T08:00:00.000Z'
			}),
			't'
		);

		expect(sent).toBe(root);
		expect(theirs).toBe(root);
	});

	it('lets a root join replies that arrived before it, but not other roots', () => {
		const t = new Threader([ME]);
		const reply = t.assign(message({ subject: 'Re: Claim' }), 'reply');
		const root = t.assign(message({ subject: 'Claim', date: '2025-09-15T09:00:00.000Z' }), 'root');
		const notice = t.assign(message({ subject: 'Statement', messageId: 'n1@x' }), 'n1');
		const again = t.assign(
			message({ subject: 'Statement', messageId: 'n2@x', date: '2025-10-16T07:40:12.000Z' }),
			'n2'
		);

		expect(root).toBe(reply);
		expect(again).not.toBe(notice);
	});

	it('needs a shared correspondent other than the user, and a date within the window', () => {
		const t = new Threader([ME]);
		const root = t.assign(message({ messageId: 'root@x' }), 'r');

		expect(t.assign(message({ subject: 'Re: Claim', from: OTHER }), 'a')).not.toBe(root);
		expect(
			t.assign(
				message({ subject: 'Re: Claim', from: OTHER, to: [{ name: '', address: ME }, THEM] }),
				'b'
			)
		).toBe(root);
		expect(
			t.assign(message({ subject: 'Re: Claim', date: '2026-01-01T00:00:00.000Z' }), 'c')
		).not.toBe(root);
		expect(t.assign(message({ subject: 'Re: Claim', date: null }), 'd')).toBe('d');
	});

	it('picks the nearest thread in time when several share the subject', () => {
		const t = new Threader([ME]);
		const old = t.assign(
			message({ subject: 'Re: Claim', date: '2025-06-01T00:00:00.000Z' }),
			'old'
		);
		const recent = t.assign(
			message({ subject: 'Re: Claim', date: '2025-09-10T00:00:00.000Z' }),
			'recent'
		);

		expect(recent).not.toBe(old);
		expect(t.assign(message({ subject: 'Re: Claim' }), 'x')).toBe(recent);
	});
});

describe('subjectKey', () => {
	it('strips reply and forward prefixes and flattens the rest', () => {
		expect(subjectKey('RE: Re[2]: Fwd:  Hello   world ')).toEqual({
			key: 'hello world',
			reply: true
		});
		expect(subjectKey('Hello world')).toEqual({ key: 'hello world', reply: false });
		expect(subjectKey('Regarding: things')).toEqual({ key: 'regarding: things', reply: false });
		expect(subjectKey('  ')).toEqual({ key: '', reply: false });
	});
});
