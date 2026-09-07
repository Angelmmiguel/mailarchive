/**
 * Terms for the full-text index: lowercased Unicode words, no stemming.
 * A term records which field it came from so search can weight a subject
 * hit above a body hit.
 */
import type { ParsedMessage } from './message';

export const FIELD_SUBJECT = 1;
export const FIELD_NAMES = 2;
export const FIELD_BODY = 4;

export const MIN_TERM = 2;
export const MAX_TERM = 40;

export interface Term {
	term: string;
	field: number;
	frequency: number;
}

export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu)) {
		const word = match[0].normalize('NFKC');
		if (word.length >= MIN_TERM && word.length <= MAX_TERM) out.push(word);
	}
	return out;
}

/** The terms of one message, one entry per distinct term and field. */
export function termsOf(message: ParsedMessage): Term[] {
	const names = [message.from, ...message.to, ...message.cc]
		.filter((a) => a !== null)
		.flatMap((a) => [a.name, a.address, a.address.split('@')[0] ?? '']);
	const counted = new Map<string, Term>();
	const count = (text: string, field: number): void => {
		for (const term of tokenize(text)) {
			const key = `${field}:${term}`;
			const entry = counted.get(key);
			if (entry === undefined) counted.set(key, { term, field, frequency: 1 });
			else entry.frequency++;
		}
	};
	count(message.subject, FIELD_SUBJECT);
	count(names.join(' '), FIELD_NAMES);
	count(message.text, FIELD_BODY);
	return [...counted.values()];
}
