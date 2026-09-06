/**
 * The account flows against a live Go server: the real client, the real
 * Argon2id, real cookies and a real credentials file. Part of the vitest
 * `e2e` project, whose global setup builds and starts a throwaway server
 * over a temporary data directory (see tests/server.ts):
 *
 *     pnpm vitest run --project e2e
 *
 * The steps build on each other and run in file order, so a failure
 * cascades into the steps after it: read the first one. The scenario makes
 * more login attempts than the default rate limit allows in a minute, which
 * is why the server is started with --login-attempts raised.
 */
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import * as client from '$lib/api/client';
import { encodeBase64 } from '$lib/api/encoding';
import type { Bytes } from '$lib/api/types';
import { deriveRoot, SALT_LENGTH } from '$lib/crypto/kdf';
import { randomBytes } from '$lib/crypto/random';
import { session } from '$lib/state/session.svelte';
import { fakeStorage } from '$lib/testing/storage';
import type { Deps } from './deps';
import { WrongPassphraseError, WrongRecoveryKeyError } from './errors';
import { recover } from './recover';
import { changePassphrase, regenerateRecoveryKey } from './rotate';
import { createAccount } from './setup';
import { lock, resume, unlock } from './unlock';

const base = inject('base');

/** The real code path at the smallest cost `parseKdfParams` accepts. */
const deps: Deps = {
	api: client,
	deriveRoot: (passphrase, params) => Promise.resolve(deriveRoot(passphrase, params)),
	newKdfParams: () => ({
		name: 'argon2id',
		m: 8192,
		t: 1,
		p: 1,
		salt: encodeBase64(randomBytes(SALT_LENGTH))
	})
};

/**
 * What the browser does for the client and node's fetch does not: resolves
 * the relative paths against the server, carries the session cookie back
 * and forth, and sends the Origin a browser would, which the server checks
 * against Host.
 */
function liveFetch(base: string): typeof fetch {
	const origin = new URL(base).origin;
	const real = globalThis.fetch;
	let cookie: string | null = null;

	return async (input, init) => {
		if (typeof input !== 'string') throw new Error('the client sends string paths only');
		const headers = new Headers(init?.headers);
		headers.set('origin', origin);
		if (cookie !== null) headers.set('cookie', cookie);

		const res = await real(new URL(input, base), { ...init, headers });
		for (const set of res.headers.getSetCookie()) {
			const [pair = '', ...attributes] = set.split(';');
			const [name, value = ''] = pair.trim().split('=');
			const expired = attributes.some((a) => /^\s*max-age=(0|-\d+)\s*$/i.test(a));
			cookie = value === '' || expired ? null : `${name}=${value}`;
		}
		return res;
	};
}

function dekCopy(): Bytes {
	if (session.dek === null) throw new Error('the session is locked');
	return Uint8Array.from(session.dek);
}

describe('account flows against a live server', () => {
	const p1 = 'first passphrase of the run';
	const p2 = 'second passphrase of the run';
	const p3 = 'third passphrase of the run';
	const addresses = ['me@example.com', 'me@example.org'];
	let phrase1 = '';
	let phrase2 = '';
	let phrase3 = '';
	/** The DEK created at setup; every unlock must produce it again. */
	let dek: Bytes = new Uint8Array(0);

	beforeAll(() => {
		vi.stubGlobal('fetch', liveFetch(base));
		vi.stubGlobal('sessionStorage', fakeStorage());
		session.lock();
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	it('reports an archive that is not set up', async () => {
		await expect(client.health()).resolves.toEqual({ status: 'ok', setup: false });
	});

	it('createAccount sets up, logs in and unlocks with a 24-word phrase', async () => {
		({ recoveryPhrase: phrase1 } = await createAccount(p1, addresses, deps));

		expect(phrase1.split(' ')).toHaveLength(24);
		expect(session.status).toBe('unlocked');
		expect(session.manifest?.body).toEqual({ settings: { ownAddresses: addresses }, segments: [] });
		expect(session.manifest?.header.kdf).toMatchObject({ name: 'argon2id', m: 8192, t: 1, p: 1 });
		expect(session.manifest?.etag).not.toBe('');
		dek = dekCopy();
		await expect(client.health()).resolves.toEqual({ status: 'ok', setup: true });
	});

	it('resume reopens the session after a reload, without the passphrase', async () => {
		// A reload loses memory and keeps sessionStorage and the cookie.
		session.lock();

		await expect(resume(deps)).resolves.toBe('unlocked');
		expect(session.dek).toEqual(dek);
		expect(session.manifest?.body.settings.ownAddresses).toEqual(addresses);
	});

	it('lock revokes the session, so resume reports locked', async () => {
		await lock(deps);

		expect(session.status).toBe('locked');
		await expect(resume(deps)).resolves.toBe('locked');
		await expect(client.getManifest()).rejects.toThrow(
			expect.objectContaining({ status: 401, code: 'unauthorized' })
		);
	});

	it('unlock rejects a wrong passphrase', async () => {
		await expect(unlock('wrong passphrase x', deps)).rejects.toThrow(WrongPassphraseError);
		expect(session.status).toBe('locked');
	});

	it('unlock opens the manifest stored at setup', async () => {
		await unlock(p1, deps);

		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(dek);
		expect(session.manifest?.body.settings.ownAddresses).toEqual(addresses);
	});

	it('changePassphrase keeps this session and retires the old passphrase', async () => {
		const etag = session.manifest?.etag;

		await changePassphrase(p1, p2, deps);

		expect(session.status).toBe('unlocked');
		expect(session.manifest?.etag).not.toBe(etag);
		// The calling session survives the rekey.
		session.lock();
		await expect(resume(deps)).resolves.toBe('unlocked');

		await lock(deps);
		await expect(unlock(p1, deps)).rejects.toThrow(WrongPassphraseError);
		await unlock(p2, deps);
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(dek);
	});

	it('regenerateRecoveryKey returns a different phrase', async () => {
		({ recoveryPhrase: phrase2 } = await regenerateRecoveryKey(p2, deps));

		expect(phrase2.split(' ')).toHaveLength(24);
		expect(phrase2).not.toBe(phrase1);
		expect(session.status).toBe('unlocked');
	});

	it('recover rejects the retired phrase and accepts the current one', async () => {
		await lock(deps);

		await expect(recover(phrase1, p3, deps)).rejects.toThrow(WrongRecoveryKeyError);
		expect(session.status).toBe('locked');

		({ recoveryPhrase: phrase3 } = await recover(phrase2, p3, deps));
		expect(phrase3.split(' ')).toHaveLength(24);
		expect(phrase3).not.toBe(phrase2);
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(dek);
	});

	it('the passphrase set by recover unlocks', async () => {
		await lock(deps);
		await unlock(p3, deps);

		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(dek);
		expect(session.manifest?.body.settings.ownAddresses).toEqual(addresses);

		await lock(deps);
		expect(session.status).toBe('locked');
	});
});
