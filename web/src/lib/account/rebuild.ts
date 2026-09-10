/**
 * Rebuilding the index from the originals. A record is frozen at import,
 * so a better parser never reaches the messages already archived; this
 * run parses every raw blob again with the code as it is now, writes
 * fresh segments and swaps them for the old ones in one manifest write.
 * Blobs are content-addressed, so a view the parser still produces byte
 * for byte is not uploaded twice, and the raw blobs are never touched.
 *
 * Messages go through the parser a few at a time but are threaded in
 * date order, so the result does not depend on timing. An original the
 * server no longer has, or one the parser now refuses, keeps its record
 * as it was: a rebuild never loses a message. The manifest is written
 * last, so a cancel, a failure or a crash before that leaves the archive
 * as it was, with the new blobs unreferenced until an admin removes them.
 */
import type { BlobCache } from '$lib/cache/blobs';
import { encryptBlob } from '$lib/crypto/blob';
import type { SegmentRef } from '$lib/crypto/manifest';
import { SEGMENT_MESSAGES } from '$lib/import/run';
import { ParserClosedError, type Parser } from '$lib/import/parser';
import type { Prepared } from '$lib/import/prepare';
import type { IndexRecord, TermShard } from '$lib/index/records';
import { Threader } from '$lib/mail/thread';
import { importState } from '$lib/state/import.svelte';
import { index } from '$lib/state/index.svelte';
import { rebuildState } from '$lib/state/rebuild.svelte';
import { session } from '$lib/state/session.svelte';
import { terms } from '$lib/state/terms.svelte';
import { defaultDeps, type Api } from './deps';
import { call, LockedError } from './errors';
import { forgetMessages, MissingBlobError, openOriginal } from './messages';
import { replaceSegments, uploadSegment, type SegmentBatch } from './segments';

/** Originals fetched and parsed at once. */
export const CONCURRENCY = 3;

/** A rebuild cannot start while an import runs, or before the index is in. */
export class RebuildBlockedError extends Error {
	constructor(why: string) {
		super(`cannot rebuild the index: ${why}`);
		this.name = 'RebuildBlockedError';
	}
}

export interface RebuildDeps {
	api?: Api;
	cache?: BlobCache;
	parser: Parser;
	signal: AbortSignal;
}

/** How a run ended. */
export interface RebuildSummary {
	rebuilt: number;
	kept: number;
	cancelled: boolean;
	segments: SegmentRef[];
}

/** What one message contributes once parsed, or its old record kept. */
type Outcome = { prepared: Prepared; view: string } | 'kept';

export async function rebuildIndex({
	api = defaultDeps.api,
	cache = defaultDeps.cache,
	parser,
	signal
}: RebuildDeps): Promise<RebuildSummary> {
	const keys = session.keys;
	const manifest = session.manifest;
	if (session.status !== 'unlocked' || keys === null || manifest === null) {
		throw new LockedError();
	}
	if (importState.active) throw new RebuildBlockedError('an import is running');
	if (index.loading !== null || manifest.body.segments.some((s) => !index.segments.has(s.id))) {
		throw new RebuildBlockedError('the index is still being read');
	}
	const retired = new Set(manifest.body.segments.map((s) => s.id));
	const retiredBlobs = manifest.body.segments.flatMap((s) => [s.id, ...s.shards]);
	const snapshot = [...index.records].sort(byDate);
	rebuildState.start(snapshot.length);
	signal.addEventListener('abort', () => parser.close(), { once: true });

	const threads = new Threader(manifest.body.settings.ownAddresses);
	const outcomes: (Outcome | undefined)[] = new Array<Outcome | undefined>(snapshot.length);
	const written: { segment: SegmentRef; records: IndexRecord[]; shards: TermShard[] }[] = [];
	let batch: SegmentBatch = { records: [], terms: [] };
	let handed = 0;
	let next = 0;
	let error: unknown = null;
	let writing: Promise<void> = Promise.resolve();

	const flush = (): void => {
		const full = batch;
		batch = { records: [], terms: [] };
		writing = writing.then(async () => {
			if (full.records.length === 0 || session.keys !== keys) return;
			const { segment, shards } = await uploadSegment(keys, { api, cache }, full, (done, total) => {
				rebuildState.writing = { done, total };
			});
			rebuildState.writing = null;
			written.push({ segment, records: full.records, shards });
		});
	};

	// Records are made in snapshot order, however the parses come back, so
	// that a reply is always threaded after its root.
	const hand = (): void => {
		for (; handed < snapshot.length; handed++) {
			const outcome = outcomes[handed];
			if (outcome === undefined) return;
			const old = snapshot[handed]!;
			if (outcome === 'kept') {
				batch.records.push({
					...old,
					threadId: threads.assign({ ...old, inReplyTo: null, references: [] }, old.id)
				});
				rebuildState.kept++;
			} else {
				const { message } = outcome.prepared;
				batch.records.push({
					id: old.id,
					messageId: message.messageId,
					threadId: threads.assign(message, old.id),
					date: message.date,
					from: message.from,
					to: message.to,
					cc: message.cc,
					subject: message.subject,
					snippet: outcome.prepared.snippet,
					size: old.size,
					attachments: message.attachments,
					view: outcome.view
				});
				batch.terms.push({ id: old.id, terms: outcome.prepared.terms });
			}
			outcomes[handed] = undefined;
			rebuildState.done++;
			if (batch.records.length >= SEGMENT_MESSAGES) flush();
		}
	};

	const one = async (record: IndexRecord): Promise<Outcome> => {
		let bytes;
		try {
			bytes = await openOriginal(record, { api });
		} catch (e) {
			if (e instanceof MissingBlobError) return 'kept';
			throw e;
		}
		let prepared: Prepared;
		try {
			prepared = await parser.prepare(bytes);
		} catch (e) {
			if (e instanceof ParserClosedError) throw e;
			return 'kept';
		}
		if (session.keys !== keys) throw new LockedError();
		const view = encryptBlob(keys, prepared.view);
		// Most views come out as they were; asking first spares the upload.
		if (!(await call(api.headBlob(view.id)))) {
			await call(api.putBlob(view.id, view.sealed, signal));
		}
		return { prepared, view: view.id };
	};

	const worker = async (): Promise<void> => {
		while (next < snapshot.length && !signal.aborted && error === null) {
			const at = next++;
			try {
				outcomes[at] = await one(snapshot[at]!);
			} catch (e) {
				if (signal.aborted && isAbort(e)) return;
				error = e;
				return;
			}
			hand();
		}
	};

	try {
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snapshot.length) }, worker));
	} finally {
		parser.close();
	}

	const cancelled = signal.aborted;
	if (error === null && !cancelled) {
		rebuildState.status = 'committing';
		flush();
		try {
			await writing;
			await replaceSegments(
				retired,
				written.map((w) => w.segment),
				{ api }
			);
			if (session.keys !== keys) throw new LockedError();
			index.clear();
			terms.clear();
			forgetMessages();
			for (const { segment, records, shards } of written) {
				index.add(segment.id, records);
				terms.add(segment.id, shards);
			}
			// A segment the parser reproduces byte for byte keeps its id, and
			// so its place in the cache.
			const kept = new Set(written.flatMap((w) => [w.segment.id, ...w.segment.shards]));
			for (const id of retiredBlobs) if (!kept.has(id)) await cache.delete(id);
		} catch (e) {
			error = e;
		}
	} else {
		// Nothing of a run that stops early reaches the manifest; a segment
		// already uploaded stays on the server unreferenced.
		await writing.catch(() => {});
	}

	if (error instanceof LockedError) {
		rebuildState.status = 'cancelled';
		throw error;
	}
	if (error !== null) {
		rebuildState.error = error instanceof Error ? error.message : String(error);
		rebuildState.status = 'done';
		throw error;
	}
	rebuildState.status = cancelled ? 'cancelled' : 'done';
	return {
		rebuilt: cancelled ? 0 : rebuildState.done - rebuildState.kept,
		kept: cancelled ? 0 : rebuildState.kept,
		cancelled,
		segments: written.map((w) => w.segment)
	};
}

/** Oldest first, undated last, ties by id so the order is stable. */
function byDate(a: IndexRecord, b: IndexRecord): number {
	if (a.date === b.date) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	if (a.date === null) return 1;
	if (b.date === null) return -1;
	return a.date < b.date ? -1 : 1;
}

/** A fetch or a parse cut short by the cancel itself. */
function isAbort(e: unknown): boolean {
	return (e instanceof DOMException && e.name === 'AbortError') || e instanceof ParserClosedError;
}
