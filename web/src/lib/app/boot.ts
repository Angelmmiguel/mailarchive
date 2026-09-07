/**
 * What the shell does once per page load: asks the server whether the
 * archive is set up and, if it is, tries to reopen the session from the
 * sealed DEK a refresh leaves in sessionStorage. Screens then decide from
 * `archive` and `session` where the user belongs.
 */
import { MissingSegmentError, openIndex } from '$lib/account/segments';
import { resume } from '$lib/account/unlock';
import { archive } from '$lib/state/archive.svelte';
import { session } from '$lib/state/session.svelte';
import { toasts } from '$lib/state/toasts.svelte';

export async function boot(): Promise<void> {
	await archive.refresh();
	if (archive.health?.setup !== true || session.status === 'unlocked') return;
	try {
		if ((await resume()) !== 'unlocked') return;
	} catch {
		// Anything that stops the resume leaves the session locked, which is
		// exactly what a fresh visit looks like: the unlock screen handles it.
		session.lock();
	}
	try {
		await openIndex();
	} catch (e) {
		// The archive opens with what could be read; Unlock says the same.
		toasts.push({ tone: 'danger', label: 'index', message: indexProblem(e) }, 0);
	}
}

export function indexProblem(e: unknown): string {
	if (e instanceof MissingSegmentError) {
		return 'The manifest lists a segment the server no longer has. The index is incomplete.';
	}
	return `The index could not be read completely: ${e instanceof Error ? e.message : String(e)}`;
}
