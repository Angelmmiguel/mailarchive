/**
 * Segments in and out of the archive: loading every segment index into
 * memory after unlock, and appending the segment an import produced to
 * the manifest without overwriting what another device wrote meanwhile.
 */
import { ApiError } from '$lib/api/types';
import { decodeSegmentIndex } from '$lib/index/segment';
import { encodeManifest, type ManifestBody, type SegmentRef } from '$lib/crypto/manifest';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';
import { openManifest, requireManifest } from './unlock';

export const MANIFEST_RETRIES = 3;

/** The manifest names a segment the server does not have. */
export class MissingSegmentError extends Error {
	constructor(id: string) {
		super(`the manifest lists segment ${id.slice(0, 8)}… but the server has no such blob`);
		this.name = 'MissingSegmentError';
	}
}

/**
 * Fetches and decrypts every segment the manifest lists and the index does
 * not hold yet, reporting progress through `index.loading`.
 */
export async function openIndex(deps: Pick<Deps, 'api'> = defaultDeps): Promise<void> {
	const keys = session.keys;
	if (session.status !== 'unlocked' || keys === null || session.manifest === null) {
		throw new LockedError();
	}
	const missing = session.manifest.body.segments.filter((s) => !index.segments.has(s.id));
	if (missing.length === 0) return;
	index.loading = { done: 0, total: missing.length };
	let lost: string | null = null;
	try {
		for (const segment of missing) {
			const sealed = await call(deps.api.getBlob(segment.id));
			// Keep going: one lost blob should not hide the segments after it.
			if (sealed === null) lost ??= segment.id;
			else index.add(segment.id, await decodeSegmentIndex(keys, segment.id, sealed));
			index.loading = { done: index.loading.done + 1, total: missing.length };
		}
	} finally {
		index.loading = null;
	}
	if (lost !== null) throw new MissingSegmentError(lost);
}

/**
 * Appends a segment to the manifest under its ETag. A conflict means
 * another device wrote first: the manifest is fetched again, the lists are
 * merged and the write retried, since two imports never remove segments.
 */
export async function commitSegment(
	segment: SegmentRef,
	deps: Pick<Deps, 'api'> = defaultDeps
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		const keys = session.keys;
		if (session.status !== 'unlocked' || keys === null || session.manifest === null) {
			throw new LockedError();
		}
		const current = session.manifest;
		if (current.body.segments.some((s) => s.id === segment.id)) return;
		const body: ManifestBody = { ...current.body, segments: [...current.body.segments, segment] };
		try {
			const data = encodeManifest({ header: current.header, body }, keys.manifest);
			const { etag } = await call(deps.api.putManifest(data, current.etag));
			session.manifest = { header: current.header, body, etag };
			return;
		} catch (e) {
			if (!(e instanceof ApiError && e.code === 'conflict') || attempt + 1 >= MANIFEST_RETRIES) {
				throw e;
			}
			const dek = session.dek;
			if (dek === null) throw new LockedError();
			session.manifest = openManifest(dek, await requireManifest(deps.api));
		}
	}
}
