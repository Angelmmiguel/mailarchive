/**
 * Writing the archive back out as `.eml` files, one per message, into a
 * folder the user picked. Each file is the raw blob opened in the
 * browser, byte for byte what was imported, named by date, subject and a
 * piece of the id so that two messages never share a name. A message
 * whose blob is missing or unreadable is counted and skipped; the run
 * goes on. A lock, a cancel or a folder that stops accepting writes ends
 * it where it is.
 */
import { safeName } from '$lib/app/files';
import type { IndexRecord } from '$lib/index/records';
import { exportState } from '$lib/state/export.svelte';
import { index } from '$lib/state/index.svelte';
import { defaultDeps, type Deps } from './deps';
import { ApiError } from '$lib/api/types';
import { LockedError, ServerUnreachableError, SessionExpiredError } from './errors';
import { openOriginal } from './messages';

/** Raw blobs fetched at once. */
export const CONCURRENCY = 3;

/**
 * The part of a directory handle the run uses, so a test can hand in a
 * map. The browser's `FileSystemDirectoryHandle` satisfies it.
 */
export interface ExportFolder {
	getDirectoryHandle(name: string, options: { create: true }): Promise<ExportFolder>;
	getFileHandle(name: string, options: { create: true }): Promise<ExportFile>;
}

export interface ExportFile {
	createWritable(): Promise<ExportStream>;
}

export interface ExportStream {
	write(data: FileSystemWriteChunkType): Promise<void>;
	close(): Promise<void>;
}

export interface ExportDeps {
	api?: Deps['api'];
	signal: AbortSignal;
}

/** How a run ended. */
export interface ExportSummary {
	written: number;
	failed: number;
	cancelled: boolean;
}

/**
 * Writes every message of the index into `folder`, a year per
 * subfolder. Resolves when the run ends, however it ends, unless the
 * archive was locked meanwhile, which throws.
 */
export async function exportArchive(
	folder: ExportFolder,
	{ api = defaultDeps.api, signal }: ExportDeps
): Promise<ExportSummary> {
	const records = index.records;
	exportState.start(records.length);
	const years = new Map<string, Promise<ExportFolder>>();
	let next = 0;
	let error: unknown = null;

	const folderFor = (year: string): Promise<ExportFolder> => {
		let dir = years.get(year);
		if (dir === undefined) {
			dir = folder.getDirectoryHandle(year, { create: true });
			years.set(year, dir);
		}
		return dir;
	};

	const write = async (record: IndexRecord): Promise<void> => {
		const bytes = await openOriginal(record, { api });
		const dir = await folderFor(yearOf(record));
		const file = await dir.getFileHandle(fileName(record), { create: true });
		const stream = await file.createWritable();
		try {
			await stream.write(bytes);
		} finally {
			await stream.close();
		}
	};

	const worker = async (): Promise<void> => {
		while (next < records.length && !signal.aborted && error === null) {
			const record = records[next++];
			try {
				await write(record);
			} catch (e) {
				// A lock, a server gone away or a folder that refuses a write
				// ends the run; a blob that is missing or will not open is
				// this message's problem alone.
				if (endsRun(e)) {
					error ??= e;
					return;
				}
				exportState.failed++;
			}
			exportState.done++;
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, worker));

	if (error instanceof LockedError) {
		exportState.status = 'cancelled';
		throw error;
	}
	if (error !== null) {
		exportState.error = error instanceof Error ? error.message : String(error);
		exportState.status = 'done';
		throw error;
	}
	exportState.status = signal.aborted ? 'cancelled' : 'done';
	return {
		written: exportState.done - exportState.failed,
		failed: exportState.failed,
		cancelled: signal.aborted
	};
}

/** `2021/`, or `undated/` for a message without a date. */
export function yearOf(record: Pick<IndexRecord, 'date'>): string {
	return record.date === null ? 'undated' : record.date.slice(0, 4);
}

/** `2021-09-30_Sell_order_settled_1a2b3c4d5e6f.eml`. */
export function fileName(record: Pick<IndexRecord, 'id' | 'date' | 'subject'>): string {
	const day = record.date === null ? 'undated' : record.date.slice(0, 10);
	const subject =
		record.subject.trim() === ''
			? 'no_subject'
			: safeName(record.subject).slice(0, 80).replace(/_+$/, '');
	return `${day}_${subject}_${record.id.slice(0, 12)}.eml`;
}

/** The browser reports a folder it can no longer write to as a DOMException. */
function endsRun(e: unknown): boolean {
	return (
		e instanceof LockedError ||
		e instanceof SessionExpiredError ||
		e instanceof ServerUnreachableError ||
		e instanceof ApiError ||
		(typeof DOMException !== 'undefined' && e instanceof DOMException)
	);
}
