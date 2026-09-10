/**
 * The index rebuild that is running, or the last one that ran, for
 * Settings. The run in `lib/account/rebuild.ts` writes here as it goes;
 * the screen only reads.
 */
export type RebuildStatus = 'idle' | 'running' | 'committing' | 'done' | 'cancelled';

class RebuildState {
	status = $state<RebuildStatus>('idle');
	total = $state(0);
	/** Messages parsed again, or kept as they were. */
	done = $state(0);
	/** Messages whose record was kept because the original could not be read. */
	kept = $state(0);
	/** Blobs of the segment being written, while one is. */
	writing = $state<{ done: number; total: number } | null>(null);
	/** Why the run stopped short of finishing, if it did. */
	error = $state<string | null>(null);

	active = $derived(this.status === 'running' || this.status === 'committing');

	start(total: number): void {
		this.status = 'running';
		this.total = total;
		this.done = 0;
		this.kept = 0;
		this.writing = null;
		this.error = null;
	}
}

export const rebuildState = new RebuildState();
