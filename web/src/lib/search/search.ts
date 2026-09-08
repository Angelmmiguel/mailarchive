/**
 * Running a query over the threads in memory. A thread is in when every
 * part of the query holds for one of its messages, not necessarily the
 * same one: a conversation is what the list shows, so it is what is
 * searched. Each message answers from its record for names, subject,
 * snippet, labels and date, and from the term index for its body; the
 * index may still be loading, in which case bodies answer as shards
 * arrive. A phrase is exact in the subject and the snippet; in a body,
 * where only terms are kept, it means every word of it is present whole.
 * A thread ranks by the sum of its best answers.
 */
import { byDate, type Thread } from '$lib/index/threads';
import type { IndexRecord } from '$lib/index/records';
import type { TermIndex } from '$lib/index/terms';
import { ATTACHMENTS, isOwn, labelsFor, SENT } from '$lib/mail/labels';
import type { Address } from '$lib/mail/message';
import { FIELD_BODY, FIELD_NAMES, FIELD_SUBJECT, tokenize } from '$lib/mail/tokenize';
import { hasWords, type Query } from './query';

export type Order = 'best' | 'newest' | 'oldest';

/** The order a URL names, `best` for anything else. */
export function parseOrder(value: string | null): Order {
	return value === 'newest' || value === 'oldest' ? value : 'best';
}

export interface Searched {
	thread: Thread;
	score: number;
}

const WEIGHT: Record<number, number> = { [FIELD_SUBJECT]: 3, [FIELD_NAMES]: 2, [FIELD_BODY]: 1 };
const EXACT = 1.5;

/** Lowercased, tokenized once per record; records never change. */
interface Meta {
	subject: string;
	subjectWords: string[];
	nameWords: string[];
	snippetWords: string[];
	from: string;
	to: string;
	time: number | null;
}

const metas = new WeakMap<IndexRecord, Meta>();

function metaOf(record: IndexRecord): Meta {
	let meta = metas.get(record);
	if (meta === undefined) {
		const mailbox = (a: Address): string => `${a.name} ${a.address}`.toLowerCase();
		const names = [record.from, ...record.to, ...record.cc].filter((a) => a !== null);
		const time = record.date === null ? NaN : Date.parse(record.date);
		meta = {
			subject: record.subject.toLowerCase(),
			subjectWords: tokenize(record.subject),
			nameWords: tokenize(
				names.map((a) => `${a.name} ${a.address} ${a.address.split('@')[0]}`).join(' ')
			),
			snippetWords: tokenize(record.snippet),
			from: record.from === null ? '' : mailbox(record.from),
			to: [...record.to, ...record.cc].map(mailbox).join(' '),
			time: Number.isNaN(time) ? null : time
		};
		metas.set(record, meta);
	}
	return meta;
}

/** Scores per message id for one word, from the term index; `exact` skips prefix expansions. */
function bodyScores(terms: TermIndex | null, word: string, exact = false): Map<string, number> {
	const scores = new Map<string, number>();
	if (terms === null) return scores;
	for (const hit of terms.lookup(word)) {
		if (exact && hit.term !== word) continue;
		const weight =
			(WEIGHT[hit.field] ?? 1) * (1 + Math.log2(hit.frequency)) * (hit.term === word ? EXACT : 1);
		const known = scores.get(hit.id) ?? 0;
		if (weight > known) scores.set(hit.id, weight);
	}
	return scores;
}

function metaScore(meta: Meta, word: string): number {
	const starts = (words: string[]): boolean => words.some((w) => w.startsWith(word));
	if (starts(meta.subjectWords)) return WEIGHT[FIELD_SUBJECT];
	if (starts(meta.nameWords)) return WEIGHT[FIELD_NAMES];
	if (starts(meta.snippetWords)) return WEIGHT[FIELD_BODY];
	return 0;
}

function mentions(
	text: string,
	value: string,
	own: string[],
	record: IndexRecord,
	which: 'from' | 'to'
): boolean {
	if (value === 'me') {
		const addresses =
			which === 'from' ? (record.from === null ? [] : [record.from]) : [...record.to, ...record.cc];
		return addresses.some((a) => isOwn(a.address, own));
	}
	return text.includes(value);
}

/**
 * The threads the query keeps, best match first when the query has words
 * and `order` asks for it, otherwise newest or oldest first.
 */
export function search(
	threads: Thread[],
	query: Query,
	own: string[],
	terms: TermIndex | null,
	order: Order = 'best'
): Searched[] {
	type Condition = (record: IndexRecord, meta: Meta) => number;
	const conditions: Condition[] = [];
	if (query.sent) conditions.push((r) => (labelsFor(r, own).includes(SENT) ? 1 : 0));
	if (query.attachments) conditions.push((r) => (labelsFor(r, own).includes(ATTACHMENTS) ? 1 : 0));
	if (query.after !== null || query.before !== null) {
		const after = query.after?.at ?? -Infinity;
		const before = query.before?.at ?? Infinity;
		conditions.push((_, m) => (m.time !== null && m.time >= after && m.time < before ? 1 : 0));
	}
	for (const value of query.from) {
		conditions.push((r, m) => (mentions(m.from, value, own, r, 'from') ? 1 : 0));
	}
	for (const value of query.to) {
		conditions.push((r, m) => (mentions(m.to, value, own, r, 'to') ? 1 : 0));
	}
	for (const value of query.subject) {
		conditions.push((_, m) => (m.subject.includes(value) ? 1 : 0));
	}
	for (const word of query.words) {
		const body = bodyScores(terms, word);
		conditions.push((r, m) => Math.max(body.get(r.id) ?? 0, metaScore(m, word)));
	}
	for (const phrase of query.phrases) {
		const parts = tokenize(phrase).map((w) => bodyScores(terms, w, true));
		conditions.push((r, m) => {
			if (m.subject.includes(phrase)) return WEIGHT[FIELD_SUBJECT] * 2;
			if (r.snippet.toLowerCase().includes(phrase)) return WEIGHT[FIELD_BODY] * 2;
			if (parts.length > 0 && parts.every((p) => p.has(r.id))) return WEIGHT[FIELD_BODY];
			return 0;
		});
	}
	const excluded = query.excluded.map((word) => {
		const body = bodyScores(terms, word);
		return (r: IndexRecord, m: Meta): boolean => body.has(r.id) || metaScore(m, word) > 0;
	});

	const out: Searched[] = [];
	for (const thread of threads) {
		const best = new Array<number>(conditions.length).fill(0);
		let dropped = false;
		for (const record of thread.messages) {
			const meta = metaOf(record);
			if (excluded.some((e) => e(record, meta))) {
				dropped = true;
				break;
			}
			for (let i = 0; i < conditions.length; i++) {
				best[i] = Math.max(best[i], conditions[i](record, meta));
			}
		}
		if (dropped || best.some((b) => b === 0)) continue;
		out.push({ thread, score: 1 + best.reduce((sum, b) => sum + b, 0) });
	}
	if (order === 'best' && hasWords(query)) {
		out.sort((a, b) => b.score - a.score || byDate(b.thread.latest, a.thread.latest, true));
	} else if (order === 'oldest') {
		out.sort((a, b) => byDate(a.thread.latest, b.thread.latest));
	}
	return out;
}
