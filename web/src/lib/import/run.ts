/**
 * One import run. Files stream through a bounded number of pipelines:
 * name the raw blob, check the merged index for the message, parse in the
 * worker, check again by headers, seal, upload raw and view. What survives
 * becomes segments: one every `SEGMENT_MESSAGES` messages, and one more
 * when the run ends, however it ends. A cancelled or failed run still
 * commits what it finished, unless the session is gone.
 */
import { blobId, encryptBlob, encryptBlobAs } from '$lib/crypto/blob';
import type { Subkeys } from '$lib/crypto/keys';
import type { SegmentRef } from '$lib/crypto/manifest';
import { defaultDeps, type Api } from '$lib/account/deps';
import { call, LockedError } from '$lib/account/errors';
import { commitSegment } from '$lib/account/segments';
import { ApiError } from '$lib/api/types';
import { encodeSegmentIndex, encodeShard, groupShards } from '$lib/index/segment';
import { headerKey, type IndexRecord } from '$lib/index/records';
import { threadIdFor } from '$lib/mail/thread';
import type { Term } from '$lib/mail/tokenize';
import { index } from '$lib/state/index.svelte';
import { importState } from '$lib/state/import.svelte';
import { session } from '$lib/state/session.svelte';
import { terms } from '$lib/state/terms.svelte';
import type { BlobCache } from '$lib/cache/blobs';
import { ParserClosedError, type Parser } from './parser';
import type { ImportFile } from './sources';

export const CONCURRENCY = 3;
/** Messages per segment; a run larger than this writes several. */
export const SEGMENT_MESSAGES = 5000;
/** Files above this are refused up front; the server caps a blob at 64 MiB. */
export const MAX_FILE_BYTES = 48 * 1024 * 1024;

/** How a run ended: `added` is what the new segments hold. */
export interface ImportSummary {
	added: number;
	duplicates: number;
	failed: number;
	cancelled: boolean;
	segments: SegmentRef[];
}

export interface RunDeps {
	api: Api;
	/** Defaults to the app's cache; what this run writes is read from it later. */
	cache?: BlobCache;
	parser: Parser;
	signal: AbortSignal;
}

interface Batch {
	records: IndexRecord[];
	terms: { id: string; terms: Term[] }[];
}

export async function runImport(
	files: ImportFile[],
	label: string,
	{ api, cache = defaultDeps.cache, parser, signal }: RunDeps
): Promise<ImportSummary> {
	const keys = session.keys;
	if (session.status !== 'unlocked' || keys === null || session.manifest === null) {
		throw new LockedError();
	}
	importState.begin(label, files.length);
	signal.addEventListener('abort', () => parser.close(), { once: true });
	const ticker = setInterval(() => (importState.now = Date.now()), 1000);

	let batch: Batch = { records: [], terms: [] };
	const segments: SegmentRef[] = [];
	// Ids and header keys taken by this run, so two copies of a message in
	// one folder do not both get uploaded before either reaches the index.
	const taken = new Set<string>();
	const takenHeaders = new Set<string>();
	const threads = new Map(index.threadMap());
	let next = 0;
	let error: unknown = null;
	// Segments are written one after another, even though pipelines keep
	// filling the next batch meanwhile.
	let writing: Promise<void> = Promise.resolve();

	const flush = (): void => {
		const full = batch;
		batch = { records: [], terms: [] };
		writing = writing.then(async () => {
			if (full.records.length === 0 || session.status !== 'unlocked') return;
			segments.push(await writeSegment(keys, api, cache, full));
		});
	};

	const pipeline = async (): Promise<void> => {
		while (next < files.length && !signal.aborted && error === null) {
			const file = files[next++]!;
			try {
				await one(file);
			} catch (e) {
				if (signal.aborted && isAbort(e)) return;
				error = e;
			}
			importState.counts.processed++;
			importState.now = Date.now();
		}
	};

	const one = async ({ file, path }: ImportFile): Promise<void> => {
		if (file.size > MAX_FILE_BYTES) {
			importState.fail(path, `larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB`);
			return;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const size = bytes.length;
		const id = blobId(keys.id, bytes);
		if (index.find({ id, messageId: null, date: null, from: null }) !== null || taken.has(id)) {
			importState.counts.duplicates++;
			return;
		}
		taken.add(id);
		let prepared;
		try {
			prepared = await parser.prepare(bytes);
		} catch (e) {
			if (e instanceof ParserClosedError && signal.aborted) return;
			taken.delete(id);
			importState.fail(path, reason(e));
			return;
		}
		importState.counts.parsed++;
		// Cancelled while parsing: nothing of this message reaches the server.
		if (signal.aborted) return;
		// Locked while parsing: the keys are zeros now, and nothing seals under
		// them.
		if (session.keys !== keys) throw new LockedError();
		const { message } = prepared;
		const key = headerKey(message);
		if (index.find({ id, ...message }) !== null || (key !== null && takenHeaders.has(key))) {
			importState.counts.duplicates++;
			return;
		}
		if (key !== null) takenHeaders.add(key);
		const view = encryptBlob(keys, prepared.view);
		const raw = encryptBlobAs(keys, id, prepared.raw);
		try {
			await call(api.putBlob(id, raw, signal));
			await call(api.putBlob(view.id, view.sealed, signal));
		} catch (e) {
			if (e instanceof ApiError && e.code === 'too_large') {
				importState.fail(path, 'too large for the server');
				return;
			}
			throw e;
		}
		const record: IndexRecord = {
			id,
			messageId: message.messageId,
			threadId: threadIdFor(message, threads, id),
			date: message.date,
			from: message.from,
			to: message.to,
			cc: message.cc,
			subject: message.subject,
			snippet: prepared.snippet,
			size,
			attachments: message.attachments,
			view: view.id
		};
		if (message.messageId !== null && !threads.has(message.messageId)) {
			threads.set(message.messageId, record.threadId);
		}
		batch.records.push(record);
		batch.terms.push({ id, terms: prepared.terms });
		importState.counts.uploaded++;
		if (batch.records.length >= SEGMENT_MESSAGES) flush();
	};

	try {
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, pipeline));
	} finally {
		parser.close();
		clearInterval(ticker);
	}

	importState.status = 'committing';
	flush();
	try {
		await writing;
	} catch (e) {
		error ??= e;
	}
	const cancelled = signal.aborted;
	if (error !== null) {
		importState.error = reason(error);
		importState.status = 'done';
		throw error;
	}
	importState.status = cancelled ? 'cancelled' : 'done';
	return {
		added: segments.reduce((sum, s) => sum + s.messages, 0),
		duplicates: importState.counts.duplicates,
		failed: importState.counts.failed,
		cancelled,
		segments
	};
}

async function writeSegment(
	keys: Subkeys,
	api: Api,
	cache: BlobCache,
	{ records, terms: termsOf }: Batch
): Promise<SegmentRef> {
	const indexBlob = await encodeSegmentIndex(keys, records);
	const shards = groupShards(indexBlob.id, keys, termsOf);
	const shardIds = [...shards.keys()];
	const pending = [...shards.entries()];
	importState.writing = { done: 0, total: pending.length + 1 };
	const upload = async (): Promise<void> => {
		for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
			const sealed = await encodeShard(keys, entry[0], entry[1]);
			await call(api.putBlob(entry[0], sealed.sealed));
			await cache.put(entry[0], sealed.sealed);
			importState.writing = {
				done: importState.writing.done + 1,
				total: importState.writing.total
			};
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, upload));
	await call(api.putBlob(indexBlob.id, indexBlob.sealed));
	await cache.put(indexBlob.id, indexBlob.sealed);
	const segment: SegmentRef = {
		id: indexBlob.id,
		createdAt: new Date().toISOString(),
		messages: records.length,
		shards: shardIds
	};
	await commitSegment(segment, { api });
	// The commit checked the session after its write; the same holds here
	// for the index, which a lock has emptied.
	if (session.keys !== keys) throw new LockedError();
	index.add(segment.id, records);
	terms.add(segment.id, [...shards.values()]);
	importState.writing = { done: importState.writing.total, total: importState.writing.total };
	return segment;
}

/** A fetch cancelled through its signal, before `call` translated it. */
function isAbort(e: unknown): boolean {
	return e instanceof DOMException && e.name === 'AbortError';
}

function reason(e: unknown): string {
	if (e instanceof Error) return e.message.replace(/^cannot parse message: /, '');
	return String(e);
}
