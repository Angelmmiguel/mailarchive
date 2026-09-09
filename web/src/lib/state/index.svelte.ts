/**
 * The merged index: every record of every loaded segment, in memory while
 * unlocked. Import checks new messages against it and adds what it
 * stores; the list views read from it grouped into threads. `records` is
 * `$state.raw` because a deep proxy over tens of thousands of records
 * would cost more than the reactivity is worth; replace the array to
 * notify. Threads carry labels, and `sent` depends on the own addresses in
 * the manifest, so the grouping follows the settings.
 */
import { headerKey, type IndexRecord } from '$lib/index/records';
import { groupThreads, type Thread } from '$lib/index/threads';
import { session } from './session.svelte';

export interface IndexProgress {
	done: number;
	total: number;
}

class Index {
	records = $state.raw<IndexRecord[]>([]);
	/** Segment ids whose records are in `records`. */
	segments = $state.raw<Set<string>>(new Set());
	/** Non-null while segments are being fetched and decrypted. */
	loading = $state<IndexProgress | null>(null);

	messages = $derived(this.records.length);
	/** Size of every original message, which is roughly what the server stores. */
	bytes = $derived(this.records.reduce((sum, r) => sum + r.size, 0));
	/** Newest first. */
	threads = $derived(
		groupThreads(this.records, session.manifest?.body.settings.ownAddresses ?? [])
	);
	threadById = $derived(new Map(this.threads.map((t) => [t.id, t] as [string, Thread])));

	private byId = new Map<string, IndexRecord>();
	private byHeader = new Map<string, IndexRecord>();

	/** The record with this raw id, or the record a re-export of it would duplicate. */
	find(record: {
		id: string;
		messageId: string | null;
		date: string | null;
		from: { address: string } | null;
	}): IndexRecord | null {
		const byId = this.byId.get(record.id);
		if (byId !== undefined) return byId;
		const key = headerKey(record);
		return key === null ? null : (this.byHeader.get(key) ?? null);
	}

	/** Adds the records of one segment. Records already present are skipped. */
	add(segmentId: string, records: IndexRecord[]): void {
		const fresh: IndexRecord[] = [];
		for (const record of records) {
			if (this.byId.has(record.id)) continue;
			this.byId.set(record.id, record);
			const key = headerKey(record);
			if (key !== null && !this.byHeader.has(key)) this.byHeader.set(key, record);
			fresh.push(record);
		}
		this.records = [...this.records, ...fresh];
		this.segments = new Set([...this.segments, segmentId]);
	}

	clear(): void {
		this.records = [];
		this.segments = new Set();
		this.loading = null;
		this.byId.clear();
		this.byHeader.clear();
	}
}

export const index = new Index();
