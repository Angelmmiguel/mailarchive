/**
 * The merged term index: every shard of every loaded segment, one posting
 * list per term. Terms are kept sorted so that a prefix maps to a range,
 * which is what search-as-you-type needs; the order is rebuilt lazily
 * after shards are added.
 */
import type { Posting, TermShard } from './records';

export interface Hit {
	id: string;
	field: number;
	frequency: number;
	/** The whole term the prefix expanded to. */
	term: string;
}

/** How many terms one prefix may expand to before the rest are ignored. */
export const MAX_EXPANSION = 5000;

export class TermIndex {
	private postings = new Map<string, Posting[]>();
	private sorted: string[] | null = null;
	/** Segment ids whose shards are all in. */
	readonly segments = new Set<string>();

	get size(): number {
		return this.postings.size;
	}

	add(shard: TermShard): void {
		for (const term in shard.terms) {
			const list = this.postings.get(term);
			if (list === undefined) {
				this.postings.set(term, [...shard.terms[term]]);
				this.sorted = null;
			} else {
				list.push(...shard.terms[term]);
			}
		}
	}

	/** Postings of every term starting with `prefix`, the exact term first. */
	lookup(prefix: string): Hit[] {
		const hits: Hit[] = [];
		const exact = this.postings.get(prefix);
		if (exact !== undefined) {
			for (const [id, field, frequency] of exact) hits.push({ id, field, frequency, term: prefix });
		}
		const terms = this.order();
		let expanded = 0;
		for (let i = lowerBound(terms, prefix); i < terms.length; i++) {
			const term = terms[i];
			if (!term.startsWith(prefix)) break;
			if (term === prefix) continue;
			if (++expanded > MAX_EXPANSION) break;
			for (const [id, field, frequency] of this.postings.get(term)!) {
				hits.push({ id, field, frequency, term });
			}
		}
		return hits;
	}

	clear(): void {
		this.postings.clear();
		this.sorted = null;
		this.segments.clear();
	}

	private order(): string[] {
		this.sorted ??= [...this.postings.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return this.sorted;
	}
}

/** The first index whose term is not below `prefix`. */
function lowerBound(terms: string[], prefix: string): number {
	let low = 0;
	let high = terms.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (terms[mid] < prefix) low = mid + 1;
		else high = mid;
	}
	return low;
}
