import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '$lib/state/session.svelte';

const goto = vi.fn();
const lock = vi.fn();
const cancelImport = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));
vi.mock('$lib/account/unlock', () => ({ lock: () => lock(), LOCK_CHANNEL: 'mailarchive.lock' }));
vi.mock('$lib/import/start', () => ({ cancelImport: () => cancelImport() }));

import { followLocks, isLeaving, leave, LOCK_GRACE, lockArchive } from './lock';

beforeEach(() => {
	goto.mockReset();
	lock.mockReset().mockResolvedValue(undefined);
	cancelImport.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	session.lock();
});

describe('leave', () => {
	it('locks, then goes to Unlock with the way back and the reason', async () => {
		await leave('/settings', 'expired');
		expect(lock).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith('/unlock?reason=expired&next=%2Fsettings');
		expect(lock.mock.invocationCallOrder[0]).toBeLessThan(goto.mock.invocationCallOrder[0]!);
	});

	it('reports that it is under way until the navigation is made', async () => {
		let during = false;
		lock.mockImplementation(async () => {
			during = isLeaving();
		});
		expect(isLeaving()).toBe(false);
		await leave('/');
		expect(during).toBe(true);
		expect(isLeaving()).toBe(false);
	});
});

describe('lockArchive', () => {
	it('lets a running import commit before the keys go', async () => {
		await lockArchive('/');
		expect(cancelImport).toHaveBeenCalledTimes(1);
		expect(cancelImport.mock.invocationCallOrder[0]).toBeLessThan(
			lock.mock.invocationCallOrder[0]!
		);
		expect(goto).toHaveBeenCalledWith('/unlock');
	});

	it('locks anyway when the commit does not finish in time', async () => {
		vi.useFakeTimers();
		cancelImport.mockReturnValue(new Promise(() => {}));

		const locking = lockArchive('/');
		await vi.advanceTimersByTimeAsync(LOCK_GRACE - 1);
		expect(lock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await locking;
		expect(lock).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith('/unlock');
	});
});

describe('followLocks', () => {
	it('leaves when another tab locks, and only while unlocked', async () => {
		lock.mockImplementation(async () => session.lock());
		const stop = followLocks(() => '/t/abc');
		const other = new BroadcastChannel('mailarchive.lock');
		try {
			other.postMessage('locked');
			await vi.waitFor(() => expect(goto).not.toHaveBeenCalled());

			session.unlock(new Uint8Array(32), {
				header: {
					version: 1,
					kdf: { name: 'argon2id', m: 8192, t: 1, p: 1, salt: 'AAAA' },
					wrapped: { passphrase: '', recovery: '' }
				},
				body: { settings: { ownAddresses: [] }, segments: [] },
				etag: '"v1"'
			});
			other.postMessage('locked');
			await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/unlock?next=%2Ft%2Fabc'));
			expect(lock).toHaveBeenCalledTimes(1);
		} finally {
			other.close();
			stop();
		}
	});
});
