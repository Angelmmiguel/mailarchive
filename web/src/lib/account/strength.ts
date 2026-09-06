/**
 * Passphrase strength as shown while one is typed. Length carries most of
 * the weight, since the KDF is slow and the passphrase is never reused
 * anywhere; word count rewards the diceware style the design suggests.
 * Below `MIN_PASSPHRASE` code points the passphrase is rejected outright.
 */
import { MIN_PASSPHRASE } from '$lib/crypto/kdf';

export type StrengthLevel = 'too short' | 'weak' | 'fair' | 'good' | 'strong';

export interface Strength {
	level: StrengthLevel;
	/** Filled bars out of `STRENGTH_BARS`. */
	score: 0 | 1 | 2 | 3 | 4;
	/** Code points after NFKC normalisation, as the KDF counts them. */
	characters: number;
	/** Whitespace-separated words. */
	words: number;
}

export const STRENGTH_BARS = 4;

export function passphraseStrength(passphrase: string): Strength {
	const normalized = passphrase.normalize('NFKC');
	const characters = Array.from(normalized).length;
	const words = normalized.trim() === '' ? 0 : normalized.trim().split(/\s+/).length;
	const score = scoreOf(characters, words);
	const levels: StrengthLevel[] = ['too short', 'weak', 'fair', 'good', 'strong'];
	return { level: levels[score] ?? 'too short', score, characters, words };
}

function scoreOf(characters: number, words: number): Strength['score'] {
	if (characters < MIN_PASSPHRASE) return 0;
	if (characters >= 28 || (characters >= 20 && words >= 4)) return 4;
	if (characters >= 20 || (characters >= 16 && words >= 3)) return 3;
	if (characters >= 16) return 2;
	return 1;
}
