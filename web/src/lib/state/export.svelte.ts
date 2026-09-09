/**
 * The export that is running, or the last one that ran, for Settings.
 * The run in `lib/account/export.ts` writes here as it goes; the screen
 * only reads.
 */
export type ExportStatus = 'idle' | 'running' | 'done' | 'cancelled';

class ExportState {
	status = $state<ExportStatus>('idle');
	total = $state(0);
	/** Messages written, or given up on. */
	done = $state(0);
	failed = $state(0);
	/** Why the run stopped short of finishing, if it did. */
	error = $state<string | null>(null);

	active = $derived(this.status === 'running');

	start(total: number): void {
		this.status = 'running';
		this.total = total;
		this.done = 0;
		this.failed = 0;
		this.error = null;
	}
}

export const exportState = new ExportState();
