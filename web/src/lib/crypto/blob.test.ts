import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { SealError } from './aead';
import { blobId, decryptBlob, encryptBlob } from './blob';
import { deriveSubkeys } from './keys';

const keys = deriveSubkeys(new Uint8Array(32).map((_, i) => i * 9));
const plaintext = new TextEncoder().encode('From: a@example.com\r\nSubject: hi\r\n\r\nbody');

describe('blobId', () => {
	it('is 64 lowercase hex characters', () => {
		expect(blobId(keys.id, plaintext)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is HMAC-SHA256 over the SHA-256 of the plaintext', () => {
		expect(blobId(keys.id, plaintext)).toBe(bytesToHex(hmac(sha256, keys.id, sha256(plaintext))));
	});

	it('is deterministic, and depends on both key and plaintext', () => {
		const id = blobId(keys.id, plaintext);

		expect(blobId(keys.id, plaintext)).toBe(id);
		expect(blobId(keys.blob, plaintext)).not.toBe(id);
		expect(blobId(keys.id, new TextEncoder().encode('other'))).not.toBe(id);
	});
});

describe('encryptBlob and decryptBlob', () => {
	it('round-trip', () => {
		const { id, sealed } = encryptBlob(keys, plaintext);

		expect(id).toBe(blobId(keys.id, plaintext));
		expect(sealed).not.toEqual(plaintext);
		expect(decryptBlob(keys, id, sealed)).toEqual(plaintext);
	});

	it('refuses a blob served under another id', () => {
		const { sealed } = encryptBlob(keys, plaintext);
		const other = blobId(keys.id, new TextEncoder().encode('other'));

		expect(() => decryptBlob(keys, other, sealed)).toThrow(SealError);
	});

	it('refuses a tampered blob', () => {
		const { id, sealed } = encryptBlob(keys, plaintext);
		sealed[sealed.length - 5] ^= 0x80;

		expect(() => decryptBlob(keys, id, sealed)).toThrow(SealError);
	});

	it('refuses a blob under other keys', () => {
		const { id, sealed } = encryptBlob(keys, plaintext);
		const other = deriveSubkeys(new Uint8Array(32));

		expect(() => decryptBlob(other, id, sealed)).toThrow(SealError);
	});
});
