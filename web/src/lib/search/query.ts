/**
 * The query language of the search box: words, "phrases", -exclusions and
 * `key:value` operators, all in one string so that the URL, the chips and
 * the box agree. A token that looks like an operator but is not one is
 * searched for as it was typed.
 */
import { tokenize } from '$lib/mail/tokenize';

export interface DateBound {
	/** As typed: 2026, 2026-08 or 2026-08-03. */
	text: string;
	/** Milliseconds since the epoch of the day the bound names, UTC. */
	at: number;
}

export interface Query {
	/** Prefixes matched against subject, names and body. */
	words: string[];
	/** Lowercased, searched for as they stand. */
	phrases: string[];
	/** Threads with any of these are dropped. */
	excluded: string[];
	from: string[];
	to: string[];
	subject: string[];
	attachments: boolean;
	sent: boolean;
	/** On or after this day. */
	after: DateBound | null;
	/** Before this day. */
	before: DateBound | null;
}

export const EMPTY: Query = {
	words: [],
	phrases: [],
	excluded: [],
	from: [],
	to: [],
	subject: [],
	attachments: false,
	sent: false,
	after: null,
	before: null
};

const OPERATORS = ['from', 'to', 'subject', 'has', 'is', 'after', 'before'] as const;
type Operator = (typeof OPERATORS)[number];

export function parseQuery(text: string): Query {
	const query: Query = {
		...EMPTY,
		words: [],
		phrases: [],
		excluded: [],
		from: [],
		to: [],
		subject: []
	};
	for (const token of tokens(text)) {
		const negated = token.startsWith('-') && token.length > 1;
		const body = negated ? token.slice(1) : token;
		const colon = body.indexOf(':');
		const key = colon > 0 ? body.slice(0, colon).toLowerCase() : null;
		const value = key === null ? '' : unquote(body.slice(colon + 1));
		if (key !== null && isOperator(key) && value !== '' && !negated) {
			if (apply(query, key, value)) continue;
		}
		if (negated) {
			query.excluded.push(...tokenize(body));
		} else if (body.startsWith('"')) {
			const phrase = unquote(body).toLowerCase().trim();
			if (phrase !== '') query.phrases.push(phrase);
		} else {
			query.words.push(...tokenize(body));
		}
	}
	return query;
}

/** Whether the query narrows anything at all. */
export function isEmpty(query: Query): boolean {
	return (
		query.words.length === 0 &&
		query.phrases.length === 0 &&
		query.excluded.length === 0 &&
		query.from.length === 0 &&
		query.to.length === 0 &&
		query.subject.length === 0 &&
		!query.attachments &&
		!query.sent &&
		query.after === null &&
		query.before === null
	);
}

/** Whether the query has anything for relevance to rank by. */
export function hasWords(query: Query): boolean {
	return query.words.length > 0 || query.phrases.length > 0;
}

/**
 * The query with every `key:` token removed and, unless `value` is null,
 * `key:value` appended. This is how the chips edit the box.
 */
export function setOperator(text: string, key: Operator, value: string | null): string {
	const kept = tokens(text).filter((t) => !t.toLowerCase().startsWith(`${key}:`));
	if (value !== null) kept.push(`${key}:${/\s/.test(value) ? `"${value}"` : value}`);
	return kept.join(' ');
}

/** The query without any date bound. */
export function withoutDates(text: string): string {
	return setOperator(setOperator(text, 'after', null), 'before', null);
}

/** Splits on whitespace, keeping quoted runs together with their quotes. */
export function tokens(text: string): string[] {
	const out: string[] = [];
	let token = '';
	let quoted = false;
	for (const char of text) {
		if (char === '"') quoted = !quoted;
		if (/\s/.test(char) && !quoted) {
			if (token !== '') out.push(token);
			token = '';
		} else {
			token += char;
		}
	}
	if (token !== '') out.push(token);
	return out;
}

/** 2026, 2026-08 or 2026-08-03 (slashes allowed) to the UTC start of that day. */
export function parseDate(text: string): DateBound | null {
	const match = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(text.trim());
	if (match === null) return null;
	const year = Number(match[1]);
	const month = match[2] === undefined ? 1 : Number(match[2]);
	const day = match[3] === undefined ? 1 : Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const at = Date.UTC(year, month - 1, day);
	if (new Date(at).getUTCMonth() !== month - 1) return null;
	return { text: text.trim(), at };
}

/** A bound as a query value: the day, or the month or year when it starts one. */
export function formatDate(at: number): string {
	const date = new Date(at);
	const year = String(date.getUTCFullYear());
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	if (day === '01' && month === '01') return year;
	if (day === '01') return `${year}-${month}`;
	return `${year}-${month}-${day}`;
}

function isOperator(key: string): key is Operator {
	return (OPERATORS as readonly string[]).includes(key);
}

function apply(query: Query, key: Operator, value: string): boolean {
	const lower = value.toLowerCase();
	switch (key) {
		case 'from':
			query.from.push(lower);
			return true;
		case 'to':
			query.to.push(lower);
			return true;
		case 'subject':
			query.subject.push(lower);
			return true;
		case 'has':
			if (lower !== 'attachment' && lower !== 'attachments') return false;
			query.attachments = true;
			return true;
		case 'is':
			if (lower !== 'sent') return false;
			query.sent = true;
			return true;
		case 'after':
		case 'before': {
			const bound = parseDate(value);
			if (bound === null) return false;
			query[key] = bound;
			return true;
		}
	}
}

function unquote(value: string): string {
	return value.startsWith('"') ? value.slice(1, value.endsWith('"') ? -1 : undefined) : value;
}
