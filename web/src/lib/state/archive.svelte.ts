/**
 * App-wide reactive state lives in `.svelte.ts` modules like this one: a class
 * holding `$state` fields, exported as a single instance. A module cannot
 * export a reassigned `$state` variable, because the compiler only rewrites
 * references inside the file that declares it; assigning to the *fields* of an
 * exported instance keeps every importer reactive.
 */
import { health } from '$lib/api/client';
import type { Health } from '$lib/api/types';

/** The archive's server-side status, as last reported by `GET /api/health`. */
class Archive {
	/** The last successful health response, or null before the first one. */
	health = $state<Health | null>(null);
	/** Why the last refresh failed, or null while the archive is reachable. */
	error = $state<string | null>(null);

	/** Reloads the health status, recording the failure instead of throwing. */
	async refresh(): Promise<void> {
		try {
			this.health = await health();
			this.error = null;
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}
}

export const archive = new Archive();
