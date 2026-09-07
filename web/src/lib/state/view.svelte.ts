/**
 * What the reading screens share: the query narrowing the list, the
 * threads it leaves in the order asked for, and the opaque names threads
 * carry in the URL. The reader finds its neighbours in the same listing
 * the list shows.
 */
import { LockedError } from '$lib/account/errors';
import { threadKey, type Thread } from '$lib/index/threads';
import { yearsOf } from '$lib/search/dates';
import { parseQuery } from '$lib/search/query';
import { search, type Order } from '$lib/search/search';
import { importState } from './import.svelte';
import { index } from './index.svelte';
import { session } from './session.svelte';
import { terms } from './terms.svelte';

class View {
	/** The search box, as typed; the URL carries it as `q`. */
	query = $state('');
	order = $state<Order>('best');
	parsed = $derived(parseQuery(this.query));
	results = $derived(
		search(
			index.threads,
			this.parsed,
			session.manifest?.body.settings.ownAddresses ?? [],
			terms.current(),
			this.order
		)
	);
	listing = $derived(this.results.map((r) => r.thread));
	/** Years with dated messages, newest first, for the date chip. */
	years = $derived(yearsOf(index.records));
	/**
	 * Segments the manifest lists that the index has not loaded: what
	 * another device added since unlock. An import's own segments reach the
	 * index right after the manifest, so they are not reported.
	 */
	pendingSegments = $derived(
		session.manifest === null || importState.active
			? 0
			: session.manifest.body.segments.filter((s) => !index.segments.has(s.id)).length
	);

	private keys = new Map<string, string>();
	private ids = new Map<string, string>();

	/** The thread's name in the URL. */
	keyFor(threadId: string): string {
		const known = this.keys.get(threadId);
		if (known !== undefined) return known;
		const keys = session.keys;
		if (keys === null) throw new LockedError();
		const key = threadKey(keys.id, threadId);
		this.keys.set(threadId, key);
		this.ids.set(key, threadId);
		return key;
	}

	/** The thread behind a URL name, or null if the archive has none. */
	threadFor(key: string): Thread | null {
		let id = this.ids.get(key);
		if (id === undefined) {
			for (const thread of index.threads) {
				if (this.keyFor(thread.id) === key) break;
			}
			id = this.ids.get(key);
			if (id === undefined) return null;
		}
		return index.threadById.get(id) ?? null;
	}

	reset(): void {
		this.query = '';
		this.order = 'best';
		this.keys.clear();
		this.ids.clear();
	}
}

export const view = new View();
