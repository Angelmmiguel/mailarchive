/**
 * Blobs the archive no longer points to: the segments and shards a rebuild
 * retired, and what an import uploaded before it crashed. The server
 * cannot tell them apart from the rest and has no route to delete
 * anything, on purpose: a session cookie must not be able to erase the
 * archive. This finds them, and hands the admin a list of paths to remove
 * by hand in the data directory. An import that is still running has
 * uploaded blobs no segment references yet, so the admin should act only
 * while nothing runs anywhere.
 */
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';
import { checkForSegments } from './sync';

/** The check cannot answer while it does not know every referenced blob. */
export class IndexIncompleteError extends Error {
	constructor() {
		super('the index is still being read');
		this.name = 'IndexIncompleteError';
	}
}

/**
 * The ids the server stores that neither the manifest, fetched again
 * first, nor any record points to, sorted.
 */
export async function findUnreferenced(deps: Pick<Deps, 'api'> = defaultDeps): Promise<string[]> {
	await checkForSegments(deps);
	const manifest = session.manifest;
	if (session.status !== 'unlocked' || manifest === null) throw new LockedError();
	if (index.loading !== null || manifest.body.segments.some((s) => !index.segments.has(s.id))) {
		throw new IndexIncompleteError();
	}
	const referenced = new Set<string>();
	for (const segment of manifest.body.segments) {
		referenced.add(segment.id);
		for (const shard of segment.shards) referenced.add(shard);
	}
	for (const record of index.records) {
		referenced.add(record.id);
		referenced.add(record.view);
	}
	const stored = await call(deps.api.listBlobs());
	if (session.manifest !== manifest) throw new LockedError();
	return stored.filter((id) => !referenced.has(id)).sort();
}

/**
 * One path per line, relative to the server's data directory, the way
 * the store lays blobs out, so that `xargs rm` on the file removes them.
 */
export function unreferencedListing(ids: string[]): string {
	return ids.map((id) => `blobs/${id.slice(0, 2)}/${id}\n`).join('');
}
