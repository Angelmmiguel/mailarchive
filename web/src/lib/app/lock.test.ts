import { beforeEach, describe, expect, it, vi } from 'vitest';

const goto = vi.fn();
const lock = vi.fn();
const cancelImport = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));
vi.mock('$lib/account/unlock', () => ({ lock: () => lock() }));
vi.mock('$lib/import/start', () => ({ cancelImport: () => cancelImport() }));

import { isLeaving, leave, lockArchive } from './lock';

beforeEach(() => {
	goto.mockReset();
	lock.mockReset().mockResolvedValue(undefined);
	cancelImport.mockReset().mockResolvedValue(undefined);
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
});
