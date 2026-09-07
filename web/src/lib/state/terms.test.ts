import { beforeEach, describe, expect, it } from 'vitest';
import { INDEX_VERSION } from '$lib/index/records';
import { terms } from './terms.svelte';

beforeEach(() => terms.clear());

describe('terms', () => {
	it('adds a segment whole and ticks the version', () => {
		const before = terms.version;
		terms.add('seg', [
			{ version: INDEX_VERSION, prefix: 'a', terms: { alpha: [['m', 1, 1]] } },
			{ version: INDEX_VERSION, prefix: 'b', terms: { beta: [['m', 4, 2]] } }
		]);
		expect(terms.version).toBe(before + 1);
		expect(terms.segments).toEqual(new Set(['seg']));
		expect(terms.current().lookup('b')).toHaveLength(1);
		terms.clear();
		expect(terms.segments.size).toBe(0);
		expect(terms.index.size).toBe(0);
	});
});
