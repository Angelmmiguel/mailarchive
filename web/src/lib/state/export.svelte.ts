/**
 * The export that is running, or the last one that ran, for Settings.
 * The run in `lib/account/export.ts` writes here as it goes; the screen
 * only reads.
 */
export type ExportStatus = 'idle' | 'running' | 'done' | 'cancelled';

export interface ExportSkip {
	subject: string;
	reason: string;
}

/** Skipped messages listed; the count keeps going past this. */
export const SKIPPED_SHOWN = 50;

class ExportState {
	status = $state<ExportStatus>('idle');
	total = $state(0);
	/** Messages written, or given up on. */
	done = $state(0);
	failed = $state(0);
	/** The first messages given up on, with why. */
	skipped = $state<ExportSkip[]>([]);
	/** Why the run stopped short of finishing, if it did. */
	error = $state<string | null>(null);

	active = $derived(this.status === 'running');

	start(total: number): void {
		this.status = 'running';
		this.total = total;
		this.done = 0;
		this.failed = 0;
		this.skipped = [];
		this.error = null;
	}

	skip(subject: string, reason: string): void {
		if (this.skipped.length < SKIPPED_SHOWN) this.skipped = [...this.skipped, { subject, reason }];
		this.failed++;
	}
}

export const exportState = new ExportState();
