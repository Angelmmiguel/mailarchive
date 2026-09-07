import { beforeEach, describe, expect, it } from 'vitest';
import { FAILURES_SHOWN, importState } from './import.svelte';

beforeEach(() => importState.reset());

describe('ImportState', () => {
	it('computes the percent from processed files', () => {
		importState.begin('x', 8);
		importState.counts.processed = 2;

		expect(importState.percent).toBe(25);
		expect(importState.active).toBe(true);
	});

	it('estimates the time left from the pace so far', () => {
		importState.begin('x', 100);
		importState.counts.processed = 10;
		importState.now = importState.startedAt! + 10_000;

		expect(importState.remaining).toBe(90);
	});

	it('caps the listed failures but keeps counting', () => {
		importState.begin('x', 100);
		for (let i = 0; i < FAILURES_SHOWN + 5; i++) importState.fail(`${i}.eml`, 'bad');

		expect(importState.failures).toHaveLength(FAILURES_SHOWN);
		expect(importState.counts.failed).toBe(FAILURES_SHOWN + 5);
	});
});
