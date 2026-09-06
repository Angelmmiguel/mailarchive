import { beforeEach, describe, expect, it } from 'vitest';
import { deriveSubkeys } from '$lib/crypto/keys';
import { createTestAccount } from '$lib/testing/account';
import { session } from './session.svelte';

beforeEach(() => {
	session.lock();
});

describe('unlock', () => {
	it('populates the keys and the manifest', () => {
		const account = createTestAccount();
		const dek = Uint8Array.from(account.dek);

		session.unlock(dek, { header: account.header, body: account.body, etag: account.etag });

		expect(session.status).toBe('unlocked');
		expect(session.dek).toBe(dek);
		expect(session.keys).toEqual(deriveSubkeys(account.dek));
		expect(session.manifest).toEqual({
			header: account.header,
			body: account.body,
			etag: account.etag
		});
	});
});

describe('lock', () => {
	it('zeroes every key and clears everything', () => {
		const account = createTestAccount();
		const dek = Uint8Array.from(account.dek);
		session.unlock(dek, { header: account.header, body: account.body, etag: account.etag });
		const keys = session.keys;
		if (keys === null) throw new Error('unlock set no keys');

		session.lock();

		expect(session.status).toBe('locked');
		expect(session.dek).toBeNull();
		expect(session.keys).toBeNull();
		expect(session.manifest).toBeNull();
		expect(dek).toEqual(new Uint8Array(32));
		for (const key of [keys.blob, keys.id, keys.manifest, keys.cache]) {
			expect(key).toEqual(new Uint8Array(32));
		}
	});

	it('is a no-op when already locked', () => {
		session.lock();

		expect(session.status).toBe('locked');
		expect(session.dek).toBeNull();
	});
});
