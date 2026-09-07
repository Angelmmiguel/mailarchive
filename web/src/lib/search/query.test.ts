import { describe, expect, it } from 'vitest';
import {
	formatDate,
	hasWords,
	isEmpty,
	parseDate,
	parseQuery,
	setOperator,
	tokens,
	withoutDates
} from './query';

describe('parseQuery', () => {
	it('splits words, phrases, exclusions and operators', () => {
		const query = parseQuery(
			'from:okafor  has:attachment Invoice "net 30" -reminder to:me subject:"Q3 vendor" after:2026-08 before:2026/09/03 is:sent'
		);
		expect(query).toEqual({
			words: ['invoice'],
			phrases: ['net 30'],
			excluded: ['reminder'],
			from: ['okafor'],
			to: ['me'],
			subject: ['q3 vendor'],
			attachments: true,
			sent: true,
			after: { text: '2026-08', at: Date.UTC(2026, 7, 1) },
			before: { text: '2026/09/03', at: Date.UTC(2026, 8, 3) }
		});
	});

	it('searches for what is not an operator as typed', () => {
		const query = parseQuery('re: budget has:photo before:yesterday from: sender:x -from:me');
		expect(query.words).toEqual([
			're',
			'budget',
			'has',
			'photo',
			'before',
			'yesterday',
			'from',
			'sender'
		]);
		expect(query.excluded).toEqual(['from', 'me']);
		expect(query.from).toEqual([]);
		expect(query.attachments).toBe(false);
	});

	it('tolerates an unterminated phrase and lone dashes', () => {
		expect(parseQuery('"open phrase').phrases).toEqual(['open phrase']);
		expect(parseQuery('- a "" xy').words).toEqual(['xy']);
		expect(parseQuery('""').phrases).toEqual([]);
	});

	it('reports emptiness and words', () => {
		expect(isEmpty(parseQuery('  '))).toBe(true);
		expect(isEmpty(parseQuery('has:attachment'))).toBe(false);
		expect(hasWords(parseQuery('has:attachment'))).toBe(false);
		expect(hasWords(parseQuery('"a b"'))).toBe(true);
	});
});

describe('tokens and operators', () => {
	it('keeps quoted runs together', () => {
		expect(tokens('a "b c" subject:"d e" -"f g" "h')).toEqual([
			'a',
			'"b c"',
			'subject:"d e"',
			'-"f g"',
			'"h'
		]);
	});

	it('replaces, removes and detects an operator without touching the rest', () => {
		expect(setOperator('invoice after:2025 x', 'after', '2026-08')).toBe('invoice x after:2026-08');
		expect(setOperator('invoice After:2025', 'after', null)).toBe('invoice');
		expect(setOperator('', 'subject', 'net 30')).toBe('subject:"net 30"');
		expect(withoutDates('x after:2025 before:2026 y')).toBe('x y');
	});
});

describe('dates', () => {
	it('parses years, months and days and rejects the rest', () => {
		expect(parseDate('2026')).toEqual({ text: '2026', at: Date.UTC(2026, 0, 1) });
		expect(parseDate('2026-2')).toEqual({ text: '2026-2', at: Date.UTC(2026, 1, 1) });
		expect(parseDate('2026-02-29')).toBeNull();
		expect(parseDate('2024-02-29')).toEqual({ text: '2024-02-29', at: Date.UTC(2024, 1, 29) });
		expect(parseDate('2026-13')).toBeNull();
		expect(parseDate('yesterday')).toBeNull();
	});

	it('formats a bound as short as it can', () => {
		expect(formatDate(Date.UTC(2026, 0, 1))).toBe('2026');
		expect(formatDate(Date.UTC(2026, 7, 1))).toBe('2026-08');
		expect(formatDate(Date.UTC(2026, 7, 9))).toBe('2026-08-09');
	});
});
