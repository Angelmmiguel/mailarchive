/**
 * Leaving the archive for Unlock, from the toolbar, from Settings or when
 * the server says the session is gone. The location travels in the URL so
 * that Unlock comes back to it.
 */
import { goto } from '$app/navigation';
import { lock } from '$lib/account/unlock';
import { cancelImport } from '$lib/import/start';
import { unlockUrl } from './navigation';

let leaving = false;

/**
 * Whether `leave` is under way. Screens redirect a locked session to Unlock
 * on their own; while a leave is going they hold back, so the one
 * navigation that carries the reason and the way back is the one made.
 */
export function isLeaving(): boolean {
	return leaving;
}

/** Drops the keys and goes to Unlock, which returns to `from`. */
export async function leave(from: string, reason?: 'expired'): Promise<void> {
	leaving = true;
	try {
		await lock();
		await goto(unlockUrl(from, reason));
	} finally {
		leaving = false;
	}
}

/** Lock as the user asks for it: a running import commits what it finished first. */
export async function lockArchive(from: string): Promise<void> {
	await cancelImport();
	await leave(from);
}
