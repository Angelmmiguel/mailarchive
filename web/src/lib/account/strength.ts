/**
 * Passphrase strength as shown while one is typed. Length carries most of
 * the weight, since the KDF is slow and the passphrase is never reused
 * anywhere; word count rewards the diceware style the design suggests. A
 * long passphrase made of a short pattern repeated, or of a handful of
 * characters, is not long in any sense that matters and stays weak. Below
 * `MIN_PASSPHRASE` code points the passphrase is rejected outright.
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
/** Distinct code points below which no length makes a passphrase more than weak. */
export const MIN_DISTINCT = 8;

export function passphraseStrength(passphrase: string): Strength {
	const normalized = passphrase.normalize('NFKC');
	const points = Array.from(normalized);
	const characters = points.length;
	const words = normalized.trim() === '' ? 0 : normalized.trim().split(/\s+/).length;
	const score = scoreOf(characters, words, new Set(points).size, repeats(points));
	const levels: StrengthLevel[] = ['too short', 'weak', 'fair', 'good', 'strong'];
	return { level: levels[score] ?? 'too short', score, characters, words };
}

function scoreOf(
	characters: number,
	words: number,
	distinct: number,
	repeated: boolean
): Strength['score'] {
	if (characters < MIN_PASSPHRASE) return 0;
	if (repeated || distinct < MIN_DISTINCT) return 1;
	if (characters >= 28 || (characters >= 20 && words >= 4)) return 4;
	if (characters >= 20 || (characters >= 16 && words >= 3)) return 3;
	if (characters >= 16) return 2;
	return 1;
}

/**
 * Whether the passphrase is a pattern repeated at least twice, complete
 * or not: `abcabcabc`, `banana banana banana`. The shortest period is the
 * length minus the longest border, the prefix that is also a suffix.
 */
function repeats(points: string[]): boolean {
	const n = points.length;
	const border = new Array<number>(n).fill(0);
	for (let i = 1, k = 0; i < n; i++) {
		while (k > 0 && points[i] !== points[k]) k = border[k - 1]!;
		if (points[i] === points[k]) k++;
		border[i] = k;
	}
	const period = n - (border[n - 1] ?? 0);
	return n > 0 && period <= n / 2;
}
