/**
 * Where to go after Unlock. The location the user was at travels in the
 * `next` query parameter; anything that is not a path inside this app
 * (another origin, a protocol-relative `//host`, garbage) falls back to the
 * archive, so a crafted link cannot send a freshly unlocked user elsewhere.
 */
import type { ResolvedPathname } from '$app/types';

export const ARCHIVE = '/' as ResolvedPathname;

export function returnPath(next: string | null): ResolvedPathname {
	if (next === null || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
		return ARCHIVE;
	}
	if (/[\s\0]/.test(next)) return ARCHIVE;
	return next as ResolvedPathname;
}

/** The Unlock URL that comes back to `from` afterwards. */
export function unlockUrl(from: string, reason?: 'expired'): ResolvedPathname {
	const params = new URLSearchParams();
	if (reason !== undefined) params.set('reason', reason);
	if (from !== '/') params.set('next', from);
	const query = params.toString();
	return `/unlock${query === '' ? '' : `?${query}`}` as ResolvedPathname;
}
