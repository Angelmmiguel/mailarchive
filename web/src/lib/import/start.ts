/**
 * Starting an import from the shell: wires the run to the parser, the
 * cancel button, the summary toast and the warning a browser shows when
 * the tab is closed mid-run. One run at a time; a second selection while
 * one is running is refused and said so.
 */
import { resolve } from '$app/paths';
import * as client from '$lib/api/client';
import { SessionExpiredError } from '$lib/account/errors';
import { importState } from '$lib/state/import.svelte';
import { toasts } from '$lib/state/toasts.svelte';
import { workerParser } from './parser';
import { runImport, type ImportSummary } from './run';
import { describeSelection, type ImportFile } from './sources';

let controller: AbortController | null = null;
let running: Promise<unknown> | null = null;

/** Stops the run and resolves once it has committed what it finished. */
export async function cancelImport(): Promise<void> {
	controller?.abort();
	await running;
}

export interface StartOptions {
	/** The server no longer holds the session; the shell sends the user to Unlock. */
	onexpired?: () => void;
}

/** A run with nothing to do is reported and refused. */
export async function startImport(
	files: ImportFile[],
	{ onexpired }: StartOptions = {}
): Promise<ImportSummary | null> {
	if (importState.active) {
		toasts.push({ tone: 'neutral', label: 'import', message: 'An import is already running.' });
		return null;
	}
	if (files.length === 0) {
		toasts.push({ tone: 'neutral', label: 'import', message: 'No .eml files in what was chosen.' });
		return null;
	}
	controller = new AbortController();
	importState.panelOpen = true;
	window.addEventListener('beforeunload', warn);
	const run = runImport(files, describeSelection(files), {
		api: client,
		parser: workerParser(),
		signal: controller.signal
	});
	running = run.catch(() => undefined);
	try {
		const summary = await run;
		toasts.push({
			tone: summary.cancelled ? 'neutral' : 'ok',
			label: summary.cancelled ? 'stopped' : 'done',
			message: describeSummary(summary),
			action: summary.added > 0 ? { label: 'View', href: resolve('/') } : undefined
		});
		return summary;
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			toasts.push(
				{
					tone: 'danger',
					label: 'expired',
					message:
						'Your session expired during the import. Unlock to continue; what was uploaded is kept.'
				},
				0
			);
			onexpired?.();
		} else {
			toasts.push(
				{
					tone: 'danger',
					label: 'error',
					message: `Import stopped: ${e instanceof Error ? e.message : String(e)}`
				},
				0
			);
		}
		return null;
	} finally {
		window.removeEventListener('beforeunload', warn);
		controller = null;
		running = null;
	}
}

export function describeSummary({ added, duplicates, failed, cancelled }: ImportSummary): string {
	const parts = [
		`${added.toLocaleString()} ${added === 1 ? 'message' : 'messages'} added`,
		`${duplicates.toLocaleString()} ${duplicates === 1 ? 'duplicate' : 'duplicates'}`,
		`${failed.toLocaleString()} failed`
	];
	return `${cancelled ? 'Import stopped' : 'Import finished'}. ${parts.join(', ')}.`;
}

function warn(event: BeforeUnloadEvent): void {
	event.preventDefault();
	// Chromium still wants a value to show the prompt.
	event.returnValue = 'An import is running.';
}
