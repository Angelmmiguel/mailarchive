import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from './toasts.svelte';

beforeEach(() => {
	vi.useFakeTimers();
	toasts.clear();
});
afterEach(() => vi.useRealTimers());

describe('toasts', () => {
	it('goes away on its own unless told to stay', () => {
		toasts.push({ tone: 'ok', label: 'done', message: 'a' }, 1000);
		const kept = toasts.push({ tone: 'danger', label: 'error', message: 'b' }, 0);

		vi.advanceTimersByTime(1000);
		expect(toasts.items.map((t) => t.id)).toEqual([kept]);
		toasts.dismiss(kept);
		expect(toasts.items).toEqual([]);
	});
});
