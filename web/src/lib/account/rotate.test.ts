import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { DEFAULT_KDF, expandRoot, PassphraseTooShortError, type KdfParams } from '$lib/crypto/kdf';
import { deriveSubkeys, unwrapDek } from '$lib/crypto/keys';
import { decodeManifestBody, decodeManifestHeader } from '$lib/crypto/manifest';
import { STORAGE_KEY } from '$lib/crypto/persist';
import { parseRecoveryKey } from '$lib/crypto/recovery';
import { session } from '$lib/state/session.svelte';
import {
	callOrder,
	createTestAccount,
	mockApi,
	NEW_PASSPHRASE,
	PASSPHRASE,
	tinyDeps,
	tinyDerive,
	type MockApi,
	type TestAccount,
	type TinyDeps
} from '$lib/testing/account';
import { fakeStorage } from '$lib/testing/storage';
import { LockedError, RateLimitedError, SessionExpiredError, WrongPassphraseError } from './errors';
import { changePassphrase, regenerateRecoveryKey } from './rotate';

let api: MockApi;
let deps: TinyDeps;
let storage: Storage;
let account: TestAccount;
/** A copy of the current credential as sent, since the flow zeroes it after. */
let sentCurrent: Bytes | undefined;

beforeEach(() => {
	session.lock();
	storage = fakeStorage();
	storage.setItem(STORAGE_KEY, 'persisted');
	vi.stubGlobal('sessionStorage', storage);
	account = createTestAccount();
	api = mockApi();
	deps = tinyDeps(api);
	sentCurrent = undefined;
	api.rekey.mockImplementation(async ({ currentAuthKey }) => {
		sentCurrent = Uint8Array.from(currentAuthKey);
		return { etag: '"v2"' };
	});
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: account.body,
		etag: account.etag
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function sentRekey() {
	const call = api.rekey.mock.calls[0];
	if (call === undefined) throw new Error('rekey not called');
	return call[0];
}

describe('changePassphrase', () => {
	it('rekeys the passphrase credential only, under the current etag', async () => {
		let sentAuthKey: Bytes | undefined;
		api.rekey.mockImplementation(async ({ authKey }) => {
			sentAuthKey = authKey && Uint8Array.from(authKey);
			return { etag: '"v2"' };
		});

		await changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps);

		expect(callOrder(api)).toEqual(['rekey']);
		const change = sentRekey();
		expect(change.ifMatch).toBe(account.etag);
		expect(change.recoveryAuthKey).toBeUndefined();
		expect(change.kdf).toMatchObject(DEFAULT_KDF);
		if (change.kdf === undefined) throw new Error('no kdf');
		expect(change.kdf.salt).not.toBe(account.kdf.salt);

		const passphrase = expandRoot(tinyDerive(NEW_PASSPHRASE, change.kdf));
		expect(sentAuthKey).toEqual(passphrase.authKey);
		const header = decodeManifestHeader(change.manifest);
		expect(header.kdf).toEqual(change.kdf);
		expect(
			unwrapDek(decodeBase64(header.wrapped.passphrase), passphrase.kek, 'passphrase')
		).toEqual(account.dek);
		// The recovery wrap is carried over byte for byte.
		expect(header.wrapped.recovery).toBe(account.header.wrapped.recovery);
		expect(decodeManifestBody(change.manifest, deriveSubkeys(account.dek).manifest)).toEqual(
			account.body
		);

		expect(session.manifest).toEqual({ header, body: account.body, etag: '"v2"' });
	});

	it('presents the current passphrase, derived with the stored parameters', async () => {
		await changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps);

		// The current credential comes from the kdf the manifest records; the
		// new one from fresh parameters with a different salt.
		const kdf = session.manifest?.header.kdf;
		if (kdf === undefined) throw new Error('no manifest');
		expect(deps.deriveRoot).toHaveBeenCalledTimes(2);
		expect(deps.deriveRoot).toHaveBeenNthCalledWith(1, PASSPHRASE, account.header.kdf);
		expect(deps.deriveRoot).toHaveBeenNthCalledWith(2, NEW_PASSPHRASE, kdf);
		expect(kdf.salt).not.toBe(account.header.kdf.salt);

		expect(sentCurrent).toEqual(account.authKey);
		// Zeroed once the server has answered.
		expect(sentRekey().currentAuthKey).toEqual(new Uint8Array(32));
	});

	it('uses the injected parameters for the new passphrase', async () => {
		const params: KdfParams = {
			...DEFAULT_KDF,
			m: 8192,
			t: 1,
			salt: encodeBase64(new Uint8Array(16))
		};
		deps.newKdfParams.mockReturnValue(params);

		await changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps);

		expect(sentRekey().kdf).toEqual(params);
		expect(session.manifest?.header.kdf).toEqual(params);
	});

	it('revokes nothing locally', async () => {
		await changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps);

		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
		expect(storage.getItem(STORAGE_KEY)).toBe('persisted');
		expect(api.logout).not.toHaveBeenCalled();
		expect(api.putSessionKey).not.toHaveBeenCalled();
	});

	it.each([
		['a short current passphrase', 'short', NEW_PASSPHRASE],
		['a short new passphrase', PASSPHRASE, 'short']
	])('rejects %s before touching the server', async (_, current, next) => {
		await expect(changePassphrase(current, next, deps)).rejects.toThrow(PassphraseTooShortError);
		expect(callOrder(api)).toEqual([]);
		expect(deps.deriveRoot).not.toHaveBeenCalled();
	});

	it('needs an unlocked session', async () => {
		session.lock();

		await expect(changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps)).rejects.toThrow(LockedError);
		expect(callOrder(api)).toEqual([]);
	});

	it('reports a wrong current passphrase and keeps the manifest', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'wrong_credential'));

		await expect(changePassphrase('not the passphrase', NEW_PASSPHRASE, deps)).rejects.toThrow(
			WrongPassphraseError
		);
		expect(callOrder(api)).toEqual(['rekey']);
		expect(session.manifest?.etag).toBe(account.etag);
		expect(session.status).toBe('unlocked');
		expect(sentRekey().currentAuthKey).toEqual(new Uint8Array(32));
	});

	it('tells an expired session apart from a wrong passphrase', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps)).rejects.toThrow(
			SessionExpiredError
		);
		expect(session.manifest?.etag).toBe(account.etag);
	});

	it('reports rate limiting', async () => {
		api.rekey.mockRejectedValue(new ApiError(429, 'rate_limited'));

		await expect(changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps)).rejects.toThrow(
			RateLimitedError
		);
	});

	it('keeps the current manifest when the server refuses', async () => {
		api.rekey.mockRejectedValue(new ApiError(412, 'conflict'));

		await expect(changePassphrase(PASSPHRASE, NEW_PASSPHRASE, deps)).rejects.toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(session.manifest?.etag).toBe(account.etag);
		expect(session.manifest?.header).toEqual(account.header);
		expect(session.status).toBe('unlocked');
	});
});

describe('regenerateRecoveryKey', () => {
	it('rekeys the recovery credential only and returns the new phrase', async () => {
		let sentRecoveryAuthKey: Bytes | undefined;
		api.rekey.mockImplementation(async ({ recoveryAuthKey }) => {
			sentRecoveryAuthKey = recoveryAuthKey && Uint8Array.from(recoveryAuthKey);
			return { etag: '"v2"' };
		});

		const { recoveryPhrase } = await regenerateRecoveryKey(PASSPHRASE, deps);

		expect(callOrder(api)).toEqual(['rekey']);
		expect(recoveryPhrase).not.toBe(account.recoveryPhrase);
		const change = sentRekey();
		expect(change.ifMatch).toBe(account.etag);
		expect(change.authKey).toBeUndefined();
		expect(change.kdf).toBeUndefined();

		const recovery = expandRoot(parseRecoveryKey(recoveryPhrase));
		expect(sentRecoveryAuthKey).toEqual(recovery.authKey);
		const header = decodeManifestHeader(change.manifest);
		expect(header.kdf).toEqual(account.kdf);
		expect(header.wrapped.passphrase).toBe(account.header.wrapped.passphrase);
		expect(unwrapDek(decodeBase64(header.wrapped.recovery), recovery.kek, 'recovery')).toEqual(
			account.dek
		);

		expect(session.manifest).toEqual({ header, body: account.body, etag: '"v2"' });
		expect(session.status).toBe('unlocked');
		expect(storage.getItem(STORAGE_KEY)).toBe('persisted');
	});

	it('presents the current passphrase, derived with the stored parameters', async () => {
		await regenerateRecoveryKey(PASSPHRASE, deps);

		expect(deps.deriveRoot).toHaveBeenCalledExactlyOnceWith(PASSPHRASE, account.header.kdf);
		expect(deps.newKdfParams).not.toHaveBeenCalled();
		expect(sentCurrent).toEqual(account.authKey);
		expect(sentRekey().currentAuthKey).toEqual(new Uint8Array(32));
	});

	it('reports a wrong current passphrase and keeps the manifest', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'wrong_credential'));

		await expect(regenerateRecoveryKey('not the passphrase', deps)).rejects.toThrow(
			WrongPassphraseError
		);
		expect(session.manifest?.header).toEqual(account.header);
		expect(session.status).toBe('unlocked');
	});

	it('needs an unlocked session', async () => {
		session.lock();

		await expect(regenerateRecoveryKey(PASSPHRASE, deps)).rejects.toThrow(LockedError);
		expect(callOrder(api)).toEqual([]);
	});
});
