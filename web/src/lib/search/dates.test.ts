import { describe, expect, it } from 'vitest';
import { presetOf, presets, rangeLabel, yearsOf } from './dates';
import { parseQuery } from './query';

const now = Date.UTC(2026, 8, 7, 12);

describe('presets', () => {
	it('spells the ranges as query bounds, years newest first', () => {
		const list = presets([2024, 2026], now);
		expect(list.map((p) => [p.id, p.after, p.before])).toEqual([
			['any', null, null],
			['30d', '2026-08-08', null],
			['12m', '2025-09-07', null],
			['2026', '2026', '2027'],
			['2024', '2024', '2025']
		]);
	});

	it('recognises the preset a query spells and labels typed ranges', () => {
		const list = presets([2024], now);
		expect(presetOf(parseQuery('x after:2024 before:2025'), list)?.id).toBe('2024');
		expect(presetOf(parseQuery('x'), list)?.id).toBe('any');
		expect(presetOf(parseQuery('x after:2024'), list)).toBeNull();
		expect(rangeLabel(parseQuery('x'), list)).toBeNull();
		expect(rangeLabel(parseQuery('after:2026-08-08'), list)).toBe('Last 30 days');
		expect(rangeLabel(parseQuery('after:2024-01 before:2024-03'), list)).toBe('2024-01 – 2024-03');
		expect(rangeLabel(parseQuery('after:2024-01'), list)).toBe('since 2024-01');
		expect(rangeLabel(parseQuery('before:2024-03'), list)).toBe('before 2024-03');
	});

	it('lists the years present', () => {
		expect(
			yearsOf([
				{ date: '2024-05-01T00:00:00Z' },
				{ date: null },
				{ date: '2026-01-01T00:00:00Z' },
				{ date: '2024-12-31T23:00:00Z' }
			])
		).toEqual([2026, 2024]);
	});
});
