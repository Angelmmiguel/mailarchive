/**
 * Another device may import while this one reads. A check compares the
 * manifest's ETag with the one held; a newer manifest is adopted at once,
 * so that this device's next commit builds on it, while its unread
 * segments stay out of the index until the user asks for them, since a
 * list that reorders itself under the reader is worse than a banner.
 */
import { session } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';
import { openManifest } from './unlock';

/** How often the archive looks for segments from elsewhere, in milliseconds. */
export const SYNC_INTERVAL = 60_000;

/** Adopts a newer manifest and returns how many segments it brought. */
export async function checkForSegments(deps: Pick<Deps, 'api'> = defaultDeps): Promise<number> {
	const dek = session.dek;
	const held = session.manifest;
	if (session.status !== 'unlocked' || dek === null || held === null) {
		throw new LockedError();
	}
	const fetched = await call(deps.api.getManifest());
	// The check may have crossed a commit or a lock. A commit made the held
	// manifest newer than what was fetched, whatever the ETags say, so only
	// a fetch that started and ended on the same manifest may move it.
	if (fetched === null || session.manifest !== held || fetched.etag === held.etag) return 0;
	const opened = openManifest(dek, fetched);
	if (session.status !== 'unlocked' || session.manifest !== held) return 0;
	const known = new Set(held.body.segments.map((s) => s.id));
	session.manifest = opened;
	return opened.body.segments.filter((s) => !known.has(s.id)).length;
}
