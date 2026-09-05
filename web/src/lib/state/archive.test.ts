import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archive } from './archive.svelte';
import { health } from '$lib/api/client';
import { ApiError } from '$lib/api/types';

vi.mock('$lib/api/client', () => ({ health: vi.fn() }));

const healthMock = vi.mocked(health);

beforeEach(() => {
	healthMock.mockReset();
	archive.health = null;
	archive.error = null;
});

describe('refresh', () => {
	it('records the health response', async () => {
		healthMock.mockResolvedValue({ status: 'ok', setup: true });

		await archive.refresh();

		expect(archive.health).toEqual({ status: 'ok', setup: true });
		expect(archive.error).toBeNull();
	});

	it('records the failure instead of throwing', async () => {
		healthMock.mockRejectedValue(new ApiError(503, 'internal'));

		await expect(archive.refresh()).resolves.toBeUndefined();

		expect(archive.error).toBe('mailarchive API: 503 internal');
		expect(archive.health).toBeNull();
	});

	it('clears the error on the next success', async () => {
		healthMock.mockRejectedValueOnce(new Error('offline'));
		await archive.refresh();
		expect(archive.error).toBe('offline');

		healthMock.mockResolvedValue({ status: 'ok', setup: false });
		await archive.refresh();

		expect(archive.error).toBeNull();
		expect(archive.health).toEqual({ status: 'ok', setup: false });
	});
});
