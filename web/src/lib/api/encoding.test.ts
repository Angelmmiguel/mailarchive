import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './encoding';

describe('encodeBase64', () => {
	// Node's Buffer implements the same RFC 4648 standard alphabet with padding
	// as Go's base64.StdEncoding, which is what the server decodes.
	it('matches Go StdEncoding for every length mod 3', () => {
		for (const length of [0, 1, 2, 3, 4, 31, 32, 33]) {
			const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 0xff);
			expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
		}
	});

	it('uses the standard alphabet, not the URL-safe one', () => {
		expect(encodeBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
	});
});

describe('decodeBase64', () => {
	it('round-trips', () => {
		const bytes = new Uint8Array(64).map((_, i) => i * 3);
		const decoded = decodeBase64(encodeBase64(bytes));
		expect(decoded).toEqual(bytes);
		expect(decoded.buffer).toBeInstanceOf(ArrayBuffer);
	});

	it.each(['!!!!', 'AAA', 'AA==AA==', 'AA A=', 'AA=A', '\nAA=='])('rejects %j', (text) => {
		expect(() => decodeBase64(text)).toThrow();
	});
});
