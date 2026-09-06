import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import {
	deriveSubkeys,
	generateDek,
	unwrapDek,
	wrapDek,
	zeroSubkeys,
	type WrapPurpose
} from './keys';

const purposes: WrapPurpose[] = ['passphrase', 'recovery', 'session'];

describe('generateDek', () => {
	it('is 32 random bytes', () => {
		const a = generateDek();

		expect(a).toHaveLength(32);
		expect(a).not.toEqual(generateDek());
	});
});

describe('deriveSubkeys', () => {
	const dek = new Uint8Array(32).map((_, i) => i * 5);

	it('yields four distinct 32-byte keys', () => {
		const keys = deriveSubkeys(dek);
		const all = [keys.blob, keys.id, keys.manifest, keys.cache];

		for (const key of all) expect(key).toHaveLength(32);
		const distinct = new Set(all.map((key) => Buffer.from(key).toString('hex')));
		expect(distinct.size).toBe(4);
		expect(all).not.toContainEqual(dek);
	});

	it('is deterministic', () => {
		expect(deriveSubkeys(dek)).toEqual(deriveSubkeys(dek));
	});

	it('changes entirely with the dek', () => {
		const other = deriveSubkeys(new Uint8Array(32).map((_, i) => i * 5 + 1));
		const keys = deriveSubkeys(dek);

		for (const name of ['blob', 'id', 'manifest', 'cache'] as const) {
			expect(other[name]).not.toEqual(keys[name]);
		}
	});
});

describe('zeroSubkeys', () => {
	it('zeroes every key', () => {
		const keys = deriveSubkeys(new Uint8Array(32).map((_, i) => i));

		zeroSubkeys(keys);

		for (const key of [keys.blob, keys.id, keys.manifest, keys.cache]) {
			expect(key).toEqual(new Uint8Array(32));
		}
	});
});

describe('wrapDek and unwrapDek', () => {
	const dek = new Uint8Array(32).map((_, i) => 200 - i);
	const kek = new Uint8Array(32).map((_, i) => i * 3);

	it.each(purposes)('round-trip for %s', (purpose) => {
		const sealed = wrapDek(dek, kek, purpose);

		expect(sealed).toHaveLength(32 + 41);
		expect(unwrapDek(sealed, kek, purpose)).toEqual(dek);
	});

	it('refuses to open under another purpose', () => {
		for (const purpose of purposes) {
			const sealed = wrapDek(dek, kek, purpose);
			for (const other of purposes) {
				if (other === purpose) continue;
				expect(() => unwrapDek(sealed, kek, other)).toThrow(SealError);
			}
		}
	});

	it('refuses to open under another kek', () => {
		const sealed = wrapDek(dek, kek, 'passphrase');
		const other = new Uint8Array(32).map((_, i) => i * 3 + 1);

		expect(() => unwrapDek(sealed, other, 'passphrase')).toThrow(SealError);
	});
});
