/**
 * The import that is running, or the last one that ran, for the panel and
 * the toolbar. The run in `lib/import/run.ts` writes here as it goes; the
 * screens only read.
 */
export type ImportStatus = 'idle' | 'running' | 'committing' | 'done' | 'cancelled';

export interface ImportCounts {
	total: number;
	/** Files that reached an outcome, whichever it was. */
	processed: number;
	parsed: number;
	uploaded: number;
	duplicates: number;
	failed: number;
}

export interface ImportFailure {
	path: string;
	reason: string;
}

/** Failures and duplicates listed in the panel; the counts keep going past this. */
export const FAILURES_SHOWN = 50;

const zero = (): ImportCounts => ({
	total: 0,
	processed: 0,
	parsed: 0,
	uploaded: 0,
	duplicates: 0,
	failed: 0
});

class ImportState {
	status = $state<ImportStatus>('idle');
	/** What is being imported, for the panel title. */
	label = $state('');
	counts = $state<ImportCounts>(zero());
	failures = $state<ImportFailure[]>([]);
	/** Files skipped as already archived, with what matched. */
	duplicates = $state<ImportFailure[]>([]);
	/** Why the run stopped short of finishing, if it did. */
	error = $state<string | null>(null);
	panelOpen = $state(false);
	startedAt = $state<number | null>(null);
	/** Now, refreshed by the run so the estimate moves. */
	now = $state(0);
	/** Blobs of the segment being written, while the status is committing. */
	writing = $state<{ done: number; total: number }>({ done: 0, total: 0 });

	active = $derived(this.status === 'running' || this.status === 'committing');
	percent = $derived(
		this.counts.total === 0 ? 0 : Math.floor((this.counts.processed / this.counts.total) * 100)
	);
	/** Seconds left at the pace so far, or null before there is a pace. */
	remaining = $derived.by(() => {
		if (this.startedAt === null || this.counts.processed < 5) return null;
		const elapsed = (this.now - this.startedAt) / 1000;
		if (elapsed <= 0) return null;
		const rate = this.counts.processed / elapsed;
		return Math.round((this.counts.total - this.counts.processed) / rate);
	});

	begin(label: string, total: number): void {
		this.status = 'running';
		this.label = label;
		this.counts = { ...zero(), total };
		this.failures = [];
		this.duplicates = [];
		this.error = null;
		this.startedAt = Date.now();
		this.now = this.startedAt;
		this.writing = { done: 0, total: 0 };
	}

	fail(path: string, reason: string): void {
		if (this.failures.length < FAILURES_SHOWN) this.failures = [...this.failures, { path, reason }];
		this.counts.failed++;
	}

	duplicate(path: string, reason: string): void {
		if (this.duplicates.length < FAILURES_SHOWN) {
			this.duplicates = [...this.duplicates, { path, reason }];
		}
		this.counts.duplicates++;
	}

	reset(): void {
		this.status = 'idle';
		this.label = '';
		this.counts = zero();
		this.failures = [];
		this.duplicates = [];
		this.error = null;
		this.startedAt = null;
		this.writing = { done: 0, total: 0 };
	}
}

export const importState = new ImportState();
