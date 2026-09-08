import { describe, expect, it } from 'vitest';
import { passphraseStrength } from './strength';

describe('passphraseStrength', () => {
	it('rejects anything under the minimum length', () => {
		expect(passphraseStrength('')).toEqual({
			level: 'too short',
			score: 0,
			characters: 0,
			words: 0
		});
		expect(passphraseStrength('short pass1')).toMatchObject({ level: 'too short', score: 0 });
	});

	it('counts code points after normalisation, like the KDF', () => {
		// Eleven precomposed characters plus one combining accent is twelve
		// code points typed, eleven once NFKC composes them.
		expect(passphraseStrength('abcdefghijk' + 'é')).toMatchObject({
			characters: 12,
			level: 'weak'
		});
	});

	it('grows with length', () => {
		expect(passphraseStrength('twelvechars!')).toMatchObject({ level: 'weak', score: 1 });
		expect(passphraseStrength('sixteencharacter')).toMatchObject({ level: 'fair', score: 2 });
		expect(passphraseStrength('twenty characters ok')).toMatchObject({ level: 'good', score: 3 });
		expect(passphraseStrength('twenty eight characters long')).toMatchObject({
			level: 'strong',
			score: 4
		});
	});

	it('rewards several words', () => {
		expect(passphraseStrength('one two three four x')).toMatchObject({
			level: 'strong',
			score: 4,
			words: 5,
			characters: 20
		});
		expect(passphraseStrength('one two threeeeee')).toMatchObject({ level: 'good', words: 3 });
		expect(passphraseStrength('  spaced   words   here  ')).toMatchObject({ words: 3 });
	});
});

describe('passphraseStrength and predictable strings', () => {
	it('keeps a repeated pattern weak however long it gets', () => {
		expect(passphraseStrength('a'.repeat(28))).toMatchObject({ level: 'weak', characters: 28 });
		expect(passphraseStrength('abc'.repeat(10))).toMatchObject({ level: 'weak' });
		expect(passphraseStrength('banana banana banana banana')).toMatchObject({
			level: 'weak',
			words: 4
		});
		expect(passphraseStrength('12345678901234567890123')).toMatchObject({ level: 'weak' });
	});

	it('keeps a passphrase of few distinct characters weak', () => {
		expect(passphraseStrength('aaaa bbbb cccc dddd eeee')).toMatchObject({ level: 'weak' });
	});

	it('does not mistake a real passphrase for a pattern', () => {
		expect(passphraseStrength('correct horse battery staple')).toMatchObject({ level: 'strong' });
		expect(passphraseStrength('a nana band that plays')).toMatchObject({ level: 'strong' });
	});
});
