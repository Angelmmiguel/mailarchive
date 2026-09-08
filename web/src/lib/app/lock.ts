/**
 * Leaving the archive for Unlock, from the toolbar, from Settings, when
 * the server says the session is gone, or when another tab locked. The
 * location travels in the URL so that Unlock comes back to it.
 */
import { goto } from '$app/navigation';
import { lock, LOCK_CHANNEL } from '$lib/account/unlock';
import { cancelImport } from '$lib/import/start';
import { session } from '$lib/state/session.svelte';
import { unlockUrl } from './navigation';

/**
 * How long Lock waits for a running import to commit what it finished, in
 * milliseconds. After that the keys go regardless: a stalled request must
 * not keep the archive open, and what the commit did not reach is imported
 * again next time, since the server already holds its blobs.
 */
export const LOCK_GRACE = 10_000;

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

/** Lock as the user asks for it: a running import gets a moment to commit first. */
export async function lockArchive(from: string): Promise<void> {
	await Promise.race([cancelImport(), new Promise((r) => setTimeout(r, LOCK_GRACE))]);
	await leave(from);
}

/**
 * Follows the locks other tabs make: the session they logged out of is
 * this tab's too, so its keys and plaintext go at once rather than at the
 * next request the server refuses. Returns the function that stops
 * following. Outside a browser there is nothing to follow.
 */
export function followLocks(from: () => string): () => void {
	if (typeof BroadcastChannel === 'undefined') return () => {};
	const channel = new BroadcastChannel(LOCK_CHANNEL);
	channel.onmessage = () => {
		if (session.status === 'unlocked' && !leaving) void leave(from());
	};
	return () => channel.close();
}
