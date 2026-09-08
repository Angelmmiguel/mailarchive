import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { NONCE_LENGTH, open, OVERHEAD, seal, SealError, VERSION, ZeroKeyError } from './aead';

const key = new Uint8Array(32).map((_, i) => i);
const plaintext = new TextEncoder().encode('hello, archive');

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof SealError) return e.code;
		throw e;
	}
	throw new Error('did not throw');
}

describe('known answer', () => {
	// draft-irtf-cfrg-xchacha-03 §A.3.1, the AEAD_XCHACHA20_POLY1305 vector,
	// run through the raw library call to prove the import is the cipher we
	// think it is.
	it('xchacha20poly1305 reproduces the draft-irtf-cfrg-xchacha §A.3.1 vector', () => {
		const vectorKey = hexToBytes(
			'808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'
		);
		const nonce = hexToBytes('404142434445464748494a4b4c4d4e4f5051525354555657');
		const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7');
		const message = new TextEncoder().encode(
			"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
		);
		const ciphertext =
			'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
			'731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
			'2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
			'21f9664c97637da9768812f615c68b13b52e';
		const tag = 'c0875924c1c7987947deafd8780acf49';

		const sealed = xchacha20poly1305(vectorKey, nonce, aad).encrypt(message);

		expect(bytesToHex(sealed)).toBe(ciphertext + tag);
		expect(xchacha20poly1305(vectorKey, nonce, aad).decrypt(sealed)).toEqual(message);
	});
});

describe('seal and open', () => {
	it('round-trips under the same key and aad', () => {
		const sealed = seal(key, plaintext, 'test/v1');

		expect(sealed).toHaveLength(OVERHEAD + plaintext.length);
		expect(sealed[0]).toBe(VERSION);
		expect(open(key, sealed, 'test/v1')).toEqual(plaintext);
	});

	it('handles an empty plaintext', () => {
		const sealed = seal(key, new Uint8Array(0), 'test/v1');

		expect(sealed).toHaveLength(OVERHEAD);
		expect(open(key, sealed, 'test/v1')).toEqual(new Uint8Array(0));
	});

	it('uses a fresh nonce every time', () => {
		const a = seal(key, plaintext, 'test/v1');
		const b = seal(key, plaintext, 'test/v1');

		expect(a).not.toEqual(b);
		expect(a.subarray(1, 1 + NONCE_LENGTH)).not.toEqual(b.subarray(1, 1 + NONCE_LENGTH));
	});

	it('rejects a flipped ciphertext byte', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		sealed[1 + NONCE_LENGTH] ^= 0x01;

		expect(code(() => open(key, sealed, 'test/v1'))).toBe('auth');
	});

	it('rejects a flipped tag byte', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		sealed[sealed.length - 1] ^= 0x01;

		expect(code(() => open(key, sealed, 'test/v1'))).toBe('auth');
	});

	it('rejects a flipped nonce byte', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		sealed[5] ^= 0x01;

		expect(code(() => open(key, sealed, 'test/v1'))).toBe('auth');
	});

	it('rejects another version byte', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		sealed[0] = 0x02;

		expect(code(() => open(key, sealed, 'test/v1'))).toBe('version');
	});

	it('rejects data too short to carry a tag', () => {
		const sealed = seal(key, plaintext, 'test/v1');

		expect(code(() => open(key, sealed.subarray(0, OVERHEAD - 1), 'test/v1'))).toBe('length');
		expect(code(() => open(key, new Uint8Array(0), 'test/v1'))).toBe('length');
	});

	it('rejects the wrong aad', () => {
		const sealed = seal(key, plaintext, 'test/v1');

		expect(code(() => open(key, sealed, 'test/v2'))).toBe('auth');
	});

	it('rejects the wrong key', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		const other = new Uint8Array(32).map((_, i) => i + 1);

		expect(code(() => open(other, sealed, 'test/v1'))).toBe('auth');
	});

	it('says nothing beyond the code', () => {
		const sealed = seal(key, plaintext, 'test/v1');
		sealed[sealed.length - 1] ^= 0x01;

		expect(() => open(key, sealed, 'test/v1')).toThrow('cannot open sealed data: auth');
	});
});

describe('seal with a zeroed key', () => {
	it('refuses, so that nothing in flight seals under a locked session', () => {
		expect(() => seal(new Uint8Array(32), new Uint8Array([1]), 'x')).toThrow(ZeroKeyError);
	});
});
