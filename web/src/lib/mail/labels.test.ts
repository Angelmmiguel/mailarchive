import { describe, expect, it } from 'vitest';
import { isOwn, labelsFor } from './labels';

const attachment = { name: 'a.pdf', type: 'application/pdf', size: 1, inline: false, index: 0 };
const inline = { ...attachment, inline: true };

describe('labelsFor', () => {
	it('marks sent mail by own address, case-insensitively', () => {
		const message = { from: { name: '', address: 'Me@Example.org' }, attachments: [] };

		expect(labelsFor(message, ['me@example.org'])).toEqual(['sent']);
		expect(labelsFor(message, ['other@example.org'])).toEqual([]);
		expect(labelsFor({ from: null, attachments: [] }, ['me@example.org'])).toEqual([]);
	});

	it('marks attachments only for parts offered as files', () => {
		expect(labelsFor({ from: null, attachments: [inline] }, [])).toEqual([]);
		expect(labelsFor({ from: null, attachments: [inline, attachment] }, [])).toEqual([
			'attachments'
		]);
	});
});

describe('isOwn', () => {
	it('compares lowercase', () => {
		expect(isOwn('A@B.c', ['a@b.c'])).toBe(true);
		expect(isOwn('a@b.c', [])).toBe(false);
	});
});
