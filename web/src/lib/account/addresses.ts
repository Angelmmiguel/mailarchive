/**
 * The user's own addresses, as typed in onboarding and Settings. They are
 * matched against message headers later, so they are stored lower-cased
 * and trimmed, and a list never holds the same address twice. An address
 * may hold `*` to stand for any run of characters, such as `*@icloud.com`.
 */

/** Something with one `@`, no whitespace and a dotted domain. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalises one typed address, or returns null when it is not an email
 * address at all. The check is deliberately loose: this is the user's own
 * address, and rejecting an unusual but real one would be worse than
 * accepting a typo.
 */
export function normalizeAddress(input: string): string | null {
	const address = input.trim().toLowerCase();
	return ADDRESS.test(address) ? address : null;
}

/** `list` with `address` appended, unless it is already there. */
export function addAddress(list: readonly string[], address: string): string[] {
	return list.includes(address) ? [...list] : [...list, address];
}
