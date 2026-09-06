import { describe, expect, it } from 'vitest';
import { addAddress, normalizeAddress } from './addresses';

describe('normalizeAddress', () => {
	it('trims and lower-cases', () => {
		expect(normalizeAddress('  Maren@Okafor.IO ')).toBe('maren@okafor.io');
	});

	it('rejects what is not an address', () => {
		for (const bad of ['', 'maren', 'maren@', '@okafor.io', 'maren@okafor', 'a b@okafor.io']) {
			expect(normalizeAddress(bad)).toBeNull();
		}
	});
});

describe('addAddress', () => {
	it('appends without duplicates and without mutating', () => {
		const list = ['a@example.com'];
		expect(addAddress(list, 'b@example.com')).toEqual(['a@example.com', 'b@example.com']);
		expect(addAddress(list, 'a@example.com')).toEqual(['a@example.com']);
		expect(list).toEqual(['a@example.com']);
	});
});
