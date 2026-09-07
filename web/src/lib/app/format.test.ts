import { describe, expect, it } from 'vitest';
import { count, dateSpan, fileKind, fileSize, longDate, opensInTab, shortDate } from './format';

// Noon UTC keeps the calendar day the same in every zone a test may run in.
const NOW = new Date('2026-09-07T12:00:00Z');

describe('dates', () => {
	it('prints the day and month, with the year only outside the current one', () => {
		expect(shortDate('2026-09-03T12:00:00Z', NOW)).toBe('03 SEP');
		expect(shortDate('2025-12-25T12:00:00Z', NOW)).toBe('25 DEC 25');
		expect(shortDate(null, NOW)).toBe('');
		expect(shortDate('not a date', NOW)).toBe('');
	});

	it('prints the long form with the weekday and a placeholder without a date', () => {
		expect(longDate('2026-09-02T12:00:00Z')).toMatch(/^Wed 02 Sep 2026, \d\d:\d\d$/);
		expect(longDate(null)).toBe('no date');
	});

	it('spans two dates and collapses a single day', () => {
		expect(dateSpan('2026-08-14T12:00:00Z', '2026-09-02T12:00:00Z', NOW)).toBe('14 AUG – 02 SEP');
		expect(dateSpan('2026-09-02T12:00:00Z', '2026-09-02T12:00:00Z', NOW)).toBe('02 SEP');
		expect(dateSpan(null, '2026-09-02T12:00:00Z', NOW)).toBe('02 SEP');
		expect(dateSpan(null, null, NOW)).toBe('');
	});
});

describe('files', () => {
	it('prints sizes in the nearest unit', () => {
		expect(fileSize(88)).toBe('88 B');
		expect(fileSize(310 * 1024)).toBe('310 KB');
		expect(fileSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
		expect(fileSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
	});

	it('badges by extension, then by MIME subtype', () => {
		expect(fileKind('vendor-agreement-2026.pdf', 'application/octet-stream')).toBe('PDF');
		expect(fileKind('totals.xlsx', '')).toBe('XLSX');
		expect(fileKind('noext', 'image/png')).toBe('PNG');
		expect(fileKind('.hidden', 'application/x-something-long')).toBe('FILE');
		expect(fileKind('weird.tar.gz.backup1', 'application/gzip')).toBe('GZIP');
	});

	it('opens images, PDFs and plain text in a tab', () => {
		expect(opensInTab('image/png')).toBe(true);
		expect(opensInTab('application/pdf; name=x')).toBe(true);
		expect(opensInTab('text/plain')).toBe(true);
		expect(opensInTab('application/vnd.ms-excel')).toBe(false);
		expect(opensInTab('text/html')).toBe(false);
	});
});

describe('count', () => {
	it('pluralises', () => {
		expect(count(1, 'message')).toBe('1 message');
		expect(count(2400, 'message')).toBe('2,400 messages');
		expect(count(0, 'reply', 'replies')).toBe('0 replies');
	});
});
