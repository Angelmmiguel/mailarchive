/**
 * The full-text index in memory: the shards of every loaded segment,
 * merged. `version` ticks when shards arrive so that a search reruns;
 * the index itself is not a proxy, its posting lists are far too many.
 */
import { TermIndex } from '$lib/index/terms';
import type { TermShard } from '$lib/index/records';
import type { IndexProgress } from './index.svelte';

class Terms {
	readonly index = new TermIndex();
	/** Ticks whenever the index changes. */
	version = $state(0);
	/** Non-null while shards are being fetched and decrypted. */
	loading = $state<IndexProgress | null>(null);
	/** Segments whose shards are in, mirrored from the index for reactivity. */
	segments = $state.raw<Set<string>>(new Set());

	/** The index, read reactively: a search that calls this reruns on new shards. */
	current(): TermIndex {
		void this.version;
		return this.index;
	}

	/** Adds every shard of a segment at once, so a segment is never half in. */
	add(segmentId: string, shards: TermShard[]): void {
		for (const shard of shards) this.index.add(shard);
		this.index.segments.add(segmentId);
		this.segments = new Set(this.index.segments);
		this.version++;
	}

	clear(): void {
		this.index.clear();
		this.segments = new Set();
		this.loading = null;
		this.version++;
	}
}

export const terms = new Terms();
