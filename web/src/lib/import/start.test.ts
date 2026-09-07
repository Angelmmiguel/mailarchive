import { describe, expect, it } from 'vitest';
import { describeSummary } from './start';

describe('describeSummary', () => {
	it('spells the counts out', () => {
		expect(
			describeSummary({ added: 7410, duplicates: 128, failed: 2, cancelled: false, segments: [] })
		).toBe('Import finished. 7,410 messages added, 128 duplicates, 2 failed.');
		expect(
			describeSummary({ added: 1, duplicates: 1, failed: 0, cancelled: true, segments: [] })
		).toBe('Import stopped. 1 message added, 1 duplicate, 0 failed.');
	});
});
