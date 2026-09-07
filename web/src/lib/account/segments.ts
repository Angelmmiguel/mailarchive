/**
 * Segments in and out of the archive: loading every segment index into
 * memory after unlock, then the term shards behind them, and appending
 * the segment an import produced to the manifest without overwriting
 * what another device wrote meanwhile. Indexes and shards go through the
 * local cache: a blob read once from the server is read from disk after.
 */
import { ApiError, type Bytes } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import type { Subkeys } from '$lib/crypto/keys';
import { encodeManifest, type ManifestBody, type SegmentRef } from '$lib/crypto/manifest';
import { decodeSegmentIndex, decodeShard, IndexFormatError } from '$lib/index/segment';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { terms } from '$lib/state/terms.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';
import { openManifest, requireManifest } from './unlock';

export const MANIFEST_RETRIES = 3;
/** Shards fetched at once. */
export const SHARD_CONCURRENCY = 4;

type LoadDeps = Pick<Deps, 'api' | 'cache'>;

/** The manifest names a segment the server does not have. */
export class MissingSegmentError extends Error {
	constructor(id: string) {
		super(`the manifest lists segment ${id.slice(0, 8)}… but the server has no such blob`);
		this.name = 'MissingSegmentError';
	}
}

/** The manifest names a term shard the server does not have. */
export class MissingShardError extends Error {
	constructor(id: string) {
		super(`the manifest lists shard ${id.slice(0, 8)}… but the server has no such blob`);
		this.name = 'MissingShardError';
	}
}

/**
 * Fetches and decrypts every segment the manifest lists and the index does
 * not hold yet, reporting progress through `index.loading`.
 */
export async function openIndex(deps: LoadDeps = defaultDeps): Promise<void> {
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
			const records = await loadBlob(deps, keys, segment.id, (sealed) =>
				decodeSegmentIndex(keys, segment.id, sealed)
			);
			// Keep going: one lost blob should not hide the segments after it.
			if (records === null) lost ??= segment.id;
			else index.add(segment.id, records);
			index.loading = { done: index.loading.done + 1, total: missing.length };
		}
	} finally {
		if (session.keys === keys) index.loading = null;
	}
	if (lost !== null) throw new MissingSegmentError(lost);
}

let opening: Promise<void> = Promise.resolve();

/**
 * Fetches and decrypts the term shards of every segment the index holds
 * and the term index does not, a segment at a time so that a search never
 * sees half of one. Calls run one after another, each looking at the
 * index as it stands when its turn comes, so a segment that arrived
 * during a run is picked up by the next.
 */
export function openTerms(deps: LoadDeps = defaultDeps): Promise<void> {
	const run = opening.catch(() => {}).then(() => loadTerms(deps));
	opening = run;
	return run;
}

async function loadTerms(deps: LoadDeps): Promise<void> {
	const keys = session.keys;
	if (session.status !== 'unlocked' || keys === null || session.manifest === null) {
		throw new LockedError();
	}
	const missing = session.manifest.body.segments.filter(
		(s) => index.segments.has(s.id) && !terms.segments.has(s.id)
	);
	const total = missing.reduce((n, s) => n + s.shards.length, 0);
	if (total === 0) return;
	terms.loading = { done: 0, total };
	let lost: string | null = null;
	try {
		for (const segment of missing) {
			const shards = await loadShards(deps, keys, segment);
			if (shards === null) lost ??= segment.id;
			else terms.add(segment.id, shards);
		}
	} finally {
		if (session.keys === keys) terms.loading = null;
	}
	if (lost !== null) throw new MissingShardError(lost);
}

async function loadShards(
	deps: LoadDeps,
	keys: Subkeys,
	segment: SegmentRef
): Promise<Awaited<ReturnType<typeof decodeShard>>[] | null> {
	const pending = [...segment.shards];
	const shards: Awaited<ReturnType<typeof decodeShard>>[] = [];
	let lost = false;
	const worker = async (): Promise<void> => {
		for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
			const shard = await loadBlob(deps, keys, id, (sealed) => decodeShard(keys, id, sealed));
			if (shard === null) lost = true;
			else shards.push(shard);
			if (terms.loading !== null) {
				terms.loading = { done: terms.loading.done + 1, total: terms.loading.total };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(SHARD_CONCURRENCY, pending.length) }, worker));
	return lost ? null : shards;
}

/**
 * A blob from the cache, else from the server and into the cache. Null
 * when the server has no such blob. A cached copy that fails to decode
 * is dropped and fetched again: the server's copy is the one that counts.
 * A lock zeroes `keys` in place, so after every wait the session's keys
 * must still be these ones, or a copy that failed to open under zeroed
 * keys would be thrown away and what was decoded would outlive the lock.
 */
async function loadBlob<T>(
	deps: LoadDeps,
	keys: Subkeys,
	id: string,
	decode: (sealed: Bytes) => Promise<T>
): Promise<T | null> {
	const live = (): void => {
		if (session.keys !== keys) throw new LockedError();
	};
	const cached = await deps.cache.get(id);
	live();
	if (cached !== null) {
		try {
			const decoded = await decode(cached);
			live();
			return decoded;
		} catch (e) {
			live();
			if (!(e instanceof SealError || e instanceof IndexFormatError)) throw e;
			await deps.cache.delete(id);
			live();
		}
	}
	const sealed = await call(deps.api.getBlob(id));
	live();
	if (sealed === null) return null;
	const decoded = await decode(sealed);
	live();
	await deps.cache.put(id, sealed);
	live();
	return decoded;
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
