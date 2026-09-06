import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '$lib/state/session.svelte';
import { archive } from '$lib/state/archive.svelte';
import { fakeStorage } from '$lib/testing/storage';

const health = vi.fn();
const resume = vi.fn();
vi.mock('$lib/api/client', () => ({ health: () => health() }));
vi.mock('$lib/account/unlock', () => ({ resume: () => resume() }));

import { boot } from './boot';

beforeEach(() => {
	session.lock();
	archive.health = null;
	archive.error = null;
	vi.stubGlobal('sessionStorage', fakeStorage());
	health.mockReset();
	resume.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('boot', () => {
	it('records the health and does not resume an archive that is not set up', async () => {
		health.mockResolvedValue({ status: 'ok', setup: false });

		await boot();

		expect(archive.health).toEqual({ status: 'ok', setup: false });
		expect(resume).not.toHaveBeenCalled();
	});

	it('resumes when the archive is set up', async () => {
		health.mockResolvedValue({ status: 'ok', setup: true });
		resume.mockResolvedValue('locked');

		await boot();

		expect(resume).toHaveBeenCalledTimes(1);
	});

	it('records an unreachable server without resuming', async () => {
		health.mockRejectedValue(new TypeError('fetch failed'));

		await boot();

		expect(archive.error).toBe('fetch failed');
		expect(resume).not.toHaveBeenCalled();
	});

	it('leaves the session locked when the resume fails', async () => {
		health.mockResolvedValue({ status: 'ok', setup: true });
		resume.mockRejectedValue(new Error('manifest lost'));

		await expect(boot()).resolves.toBeUndefined();
		expect(session.status).toBe('locked');
	});
});
