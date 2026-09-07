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
	if (session.status !== 'unlocked' || dek === null || session.manifest === null) {
		throw new LockedError();
	}
	const fetched = await call(deps.api.getManifest());
	if (fetched === null || fetched.etag === session.manifest.etag) return 0;
	const opened = openManifest(dek, fetched);
	// The check may have crossed a commit or a lock; only move forward.
	const current = session.manifest;
	if (session.status !== 'unlocked' || current === null || current.etag === fetched.etag) return 0;
	const known = new Set(current.body.segments.map((s) => s.id));
	session.manifest = opened;
	return opened.body.segments.filter((s) => !known.has(s.id)).length;
}
