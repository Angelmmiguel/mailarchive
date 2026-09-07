import { describe, expect, it } from 'vitest';
import type { ParsedMessage } from './message';
import { FIELD_BODY, FIELD_NAMES, FIELD_SUBJECT, termsOf, tokenize } from './tokenize';

describe('tokenize', () => {
	it('lowercases Unicode words and drops one-letter tokens', () => {
		expect(tokenize('Tablón de Gómez, Q3 report — a 2024 review!')).toEqual([
			'tablón',
			'de',
			'gómez',
			'q3',
			'report',
			'2024',
			'review'
		]);
	});

	it('keeps dotted and apostrophised words together', () => {
		expect(tokenize("wallbox.com don't")).toEqual(['wallbox.com', "don't"]);
	});
});

describe('termsOf', () => {
	it('counts per field', () => {
		const message: ParsedMessage = {
			messageId: null,
			inReplyTo: null,
			references: [],
			date: null,
			from: { name: 'Maren Okafor', address: 'maren@okafor.io' },
			to: [],
			cc: [],
			subject: 'Invoice overdue',
			text: 'The invoice is overdue. Invoice #4471.',
			html: null,
			attachments: []
		};

		const terms = termsOf(message);

		expect(terms).toContainEqual({ term: 'invoice', field: FIELD_SUBJECT, frequency: 1 });
		expect(terms).toContainEqual({ term: 'invoice', field: FIELD_BODY, frequency: 2 });
		expect(terms).toContainEqual({ term: 'maren', field: FIELD_NAMES, frequency: 3 });
		expect(terms).toContainEqual({ term: 'okafor.io', field: FIELD_NAMES, frequency: 1 });
	});
});
