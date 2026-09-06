/**
 * What the shell does once per page load: asks the server whether the
 * archive is set up and, if it is, tries to reopen the session from the
 * sealed DEK a refresh leaves in sessionStorage. Screens then decide from
 * `archive` and `session` where the user belongs.
 */
import { resume } from '$lib/account/unlock';
import { archive } from '$lib/state/archive.svelte';
import { session } from '$lib/state/session.svelte';

export async function boot(): Promise<void> {
	await archive.refresh();
	if (archive.health?.setup !== true || session.status === 'unlocked') return;
	try {
		await resume();
	} catch {
		// Anything that stops the resume leaves the session locked, which is
		// exactly what a fresh visit looks like: the unlock screen handles it.
		session.lock();
	}
}
