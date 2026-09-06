import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { DEFAULT_KDF, expandRoot, PassphraseTooShortError } from '$lib/crypto/kdf';
import { deriveSubkeys, unwrapDek } from '$lib/crypto/keys';
import { decodeManifestBody, decodeManifestHeader } from '$lib/crypto/manifest';
import { STORAGE_KEY } from '$lib/crypto/persist';
import { InvalidRecoveryPhraseError, parseRecoveryKey } from '$lib/crypto/recovery';
import { session } from '$lib/state/session.svelte';
import {
	callOrder,
	createTestAccount,
	mockApi,
	NEW_PASSPHRASE,
	tinyDeps,
	tinyDerive,
	type MockApi,
	type TestAccount
} from '$lib/testing/account';
import { fakeStorage } from '$lib/testing/storage';
import { MissingManifestError, SessionExpiredError, WrongRecoveryKeyError } from './errors';
import { recover } from './recover';

let api: MockApi;
let storage: Storage;
let account: TestAccount;

beforeEach(() => {
	session.lock();
	storage = fakeStorage();
	vi.stubGlobal('sessionStorage', storage);
	account = createTestAccount();
	api = mockApi();
	api.login.mockResolvedValue(undefined);
	api.getManifest.mockResolvedValue({ data: account.manifest, etag: account.etag });
	api.rekey.mockResolvedValue({ etag: '"v2"' });
	api.putSessionKey.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('recover', () => {
	it('logs in with the phrase, then rekeys both credentials in one call', async () => {
		let loginKey: Bytes | null = null;
		api.login.mockImplementation(async (key) => {
			loginKey = Uint8Array.from(key);
		});
		let sentCurrent: Bytes | undefined;
		let sentAuthKey: Bytes | undefined;
		let sentRecoveryAuthKey: Bytes | undefined;
		api.rekey.mockImplementation(async ({ currentAuthKey, authKey, recoveryAuthKey }) => {
			sentCurrent = Uint8Array.from(currentAuthKey);
			sentAuthKey = authKey && Uint8Array.from(authKey);
			sentRecoveryAuthKey = recoveryAuthKey && Uint8Array.from(recoveryAuthKey);
			return { etag: '"v2"' };
		});

		const { recoveryPhrase } = await recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api));

		expect(callOrder(api)).toEqual(['login', 'getManifest', 'rekey', 'putSessionKey']);
		expect(loginKey).toEqual(account.recoveryAuthKey);
		expect(recoveryPhrase).not.toBe(account.recoveryPhrase);
		expect(recoveryPhrase.split(' ')).toHaveLength(24);

		const [change] = api.rekey.mock.calls[0];
		expect(change.ifMatch).toBe(account.etag);
		// The phrase's auth key is the current credential the rekey presents,
		// kept until the server has answered and zeroed then.
		expect(sentCurrent).toEqual(account.recoveryAuthKey);
		expect(change.currentAuthKey).toEqual(new Uint8Array(32));
		expect(change.kdf).toMatchObject(DEFAULT_KDF);
		if (change.kdf === undefined) throw new Error('no kdf');
		expect(change.kdf.salt).not.toBe(account.kdf.salt);

		// The new passphrase and the new phrase each open the DEK, and the
		// auth keys sent are the ones derived from them.
		const passphrase = expandRoot(tinyDerive(NEW_PASSPHRASE, change.kdf));
		const recovery = expandRoot(parseRecoveryKey(recoveryPhrase));
		expect(sentAuthKey).toEqual(passphrase.authKey);
		expect(sentRecoveryAuthKey).toEqual(recovery.authKey);
		const header = decodeManifestHeader(change.manifest);
		expect(header.kdf).toEqual(change.kdf);
		expect(
			unwrapDek(decodeBase64(header.wrapped.passphrase), passphrase.kek, 'passphrase')
		).toEqual(account.dek);
		expect(unwrapDek(decodeBase64(header.wrapped.recovery), recovery.kek, 'recovery')).toEqual(
			account.dek
		);
		// The body travels unchanged.
		expect(decodeManifestBody(change.manifest, deriveSubkeys(account.dek).manifest)).toEqual(
			account.body
		);

		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
		expect(session.manifest).toEqual({ header, body: account.body, etag: '"v2"' });
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('rejects a phrase with a typo before touching the server', async () => {
		const words = account.recoveryPhrase.split(' ');
		words[3] = words[3] === 'abandon' ? 'ability' : 'abandon';

		await expect(recover(words.join(' '), NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			InvalidRecoveryPhraseError
		);
		expect(callOrder(api)).toEqual([]);
	});

	it('rejects a short new passphrase before touching the server', async () => {
		await expect(recover(account.recoveryPhrase, 'short', tinyDeps(api))).rejects.toThrow(
			PassphraseTooShortError
		);
		expect(callOrder(api)).toEqual([]);
	});

	it('reports a phrase that belongs to another archive', async () => {
		api.login.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			WrongRecoveryKeyError
		);
		expect(callOrder(api)).toEqual(['login']);
		expect(session.status).toBe('locked');
	});

	it('reports a phrase the server rejects at rekey', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'wrong_credential'));

		await expect(recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			WrongRecoveryKeyError
		);
		expect(callOrder(api)).toEqual(['login', 'getManifest', 'rekey']);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('reports a session that expired between login and rekey', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			SessionExpiredError
		);
		expect(session.status).toBe('locked');
	});

	it('reports an account without a manifest', async () => {
		api.getManifest.mockResolvedValue(null);

		await expect(recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			MissingManifestError
		);
	});

	it('leaves the old credentials in place when the rekey is refused', async () => {
		api.rekey.mockRejectedValue(new ApiError(412, 'conflict'));

		await expect(recover(account.recoveryPhrase, NEW_PASSPHRASE, tinyDeps(api))).rejects.toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		expect(api.putSessionKey).not.toHaveBeenCalled();
	});
});
