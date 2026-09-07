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
import { openRecovery, type Recovery } from './recover';

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
	api.logout.mockResolvedValue(undefined);
	api.getManifest.mockResolvedValue({ data: account.manifest, etag: account.etag });
	api.rekey.mockResolvedValue({ etag: '"v2"' });
	api.putSessionKey.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('openRecovery', () => {
	it('logs in with the phrase and opens the DEK without touching the session', async () => {
		let loginKey: Bytes | null = null;
		api.login.mockImplementation(async (key) => {
			loginKey = Uint8Array.from(key);
		});

		const recovery = await openRecovery(account.recoveryPhrase, tinyDeps(api));

		expect(recovery).toBeDefined();
		expect(callOrder(api)).toEqual(['login', 'getManifest']);
		expect(loginKey).toEqual(account.recoveryAuthKey);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('rejects a phrase with a typo before touching the server', async () => {
		// Swapping a word of the real phrase would pass the 8-bit checksum
		// once in 256 runs; this phrase is a known failure (its valid form
		// ends in "art").
		const typo = Array.from({ length: 24 }, () => 'abandon').join(' ');

		await expect(openRecovery(typo, tinyDeps(api))).rejects.toThrow(InvalidRecoveryPhraseError);
		expect(callOrder(api)).toEqual([]);
	});

	it('reports a phrase that belongs to another archive', async () => {
		api.login.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(openRecovery(account.recoveryPhrase, tinyDeps(api))).rejects.toThrow(
			WrongRecoveryKeyError
		);
		expect(callOrder(api)).toEqual(['login']);
	});

	it('reports an account without a manifest and revokes the login', async () => {
		api.getManifest.mockResolvedValue(null);

		await expect(openRecovery(account.recoveryPhrase, tinyDeps(api))).rejects.toThrow(
			MissingManifestError
		);
		expect(callOrder(api)).toEqual(['login', 'getManifest', 'logout']);
	});
});

describe('Recovery', () => {
	let recovery: Recovery;

	beforeEach(async () => {
		recovery = await openRecovery(account.recoveryPhrase, tinyDeps(api));
		api.login.mockClear();
		api.getManifest.mockClear();
	});

	it('finish rekeys both credentials in one call and unlocks', async () => {
		let sentCurrent: Bytes | undefined;
		let sentAuthKey: Bytes | undefined;
		let sentRecoveryAuthKey: Bytes | undefined;
		api.rekey.mockImplementation(async ({ currentAuthKey, authKey, recoveryAuthKey }) => {
			sentCurrent = Uint8Array.from(currentAuthKey);
			sentAuthKey = authKey && Uint8Array.from(authKey);
			sentRecoveryAuthKey = recoveryAuthKey && Uint8Array.from(recoveryAuthKey);
			return { etag: '"v2"' };
		});

		const { recoveryPhrase } = await recovery.finish(NEW_PASSPHRASE);

		expect(callOrder(api)).toEqual(['rekey', 'putSessionKey']);
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
		const recoveryKeys = expandRoot(parseRecoveryKey(recoveryPhrase));
		expect(sentAuthKey).toEqual(passphrase.authKey);
		expect(sentRecoveryAuthKey).toEqual(recoveryKeys.authKey);
		const header = decodeManifestHeader(change.manifest);
		expect(header.kdf).toEqual(change.kdf);
		expect(
			unwrapDek(decodeBase64(header.wrapped.passphrase), passphrase.kek, 'passphrase')
		).toEqual(account.dek);
		expect(unwrapDek(decodeBase64(header.wrapped.recovery), recoveryKeys.kek, 'recovery')).toEqual(
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

	it('finish rejects a short passphrase before touching the server', async () => {
		await expect(recovery.finish('short')).rejects.toThrow(PassphraseTooShortError);
		expect(callOrder(api)).toEqual([]);
	});

	it('finish reports a phrase the server rejects at rekey', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'wrong_credential'));

		await expect(recovery.finish(NEW_PASSPHRASE)).rejects.toThrow(WrongRecoveryKeyError);
		expect(callOrder(api)).toEqual(['rekey']);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('finish reports a login that expired meanwhile', async () => {
		api.rekey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(recovery.finish(NEW_PASSPHRASE)).rejects.toThrow(SessionExpiredError);
		expect(session.status).toBe('locked');
	});

	it('a refused rekey leaves the old credentials in place and can be retried', async () => {
		api.rekey.mockRejectedValueOnce(new ApiError(412, 'conflict'));
		api.getManifest.mockResolvedValue({ data: account.manifest, etag: '"v1b"' });

		await expect(recovery.finish(NEW_PASSPHRASE)).rejects.toThrow(
			expect.objectContaining({ code: 'conflict' })
		);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		expect(api.putSessionKey).not.toHaveBeenCalled();

		// The other device's manifest was picked up for the retry.
		await recovery.finish(NEW_PASSPHRASE);
		expect(callOrder(api)).toEqual(['rekey', 'getManifest', 'rekey', 'putSessionKey']);
		expect(api.rekey.mock.calls[1][0].ifMatch).toBe('"v1b"');
		expect(session.status).toBe('unlocked');
	});

	it('abandon zeroes the keys and logs out, once', async () => {
		let sentCurrent: Bytes | undefined;
		api.rekey.mockImplementation(async ({ currentAuthKey }) => {
			sentCurrent = Uint8Array.from(currentAuthKey);
			return { etag: '"v2"' };
		});

		await recovery.abandon();
		expect(callOrder(api)).toEqual(['logout']);
		await recovery.abandon();
		expect(callOrder(api)).toEqual(['logout']);

		await expect(recovery.finish(NEW_PASSPHRASE)).rejects.toThrow(/abandoned/);
		expect(sentCurrent).toBeUndefined();
		expect(session.status).toBe('locked');
	});

	it('abandon during a finish waits for it, then leaves the session alone', async () => {
		let answer: (value: { etag: string }) => void = () => {};
		api.rekey.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

		const finishing = recovery.finish(NEW_PASSPHRASE);
		await vi.waitFor(() => expect(api.rekey).toHaveBeenCalled());
		const abandoning = recovery.abandon();
		answer({ etag: '"v2"' });
		await Promise.all([finishing, abandoning]);

		expect(api.logout).not.toHaveBeenCalled();
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
	});

	it('abandon during a finish that fails then zeroes and logs out', async () => {
		let refuse: (e: Error) => void = () => {};
		api.rekey.mockImplementation(() => new Promise((_, reject) => (refuse = reject)));

		const finishing = recovery.finish(NEW_PASSPHRASE);
		await vi.waitFor(() => expect(api.rekey).toHaveBeenCalled());
		const abandoning = recovery.abandon();
		refuse(new ApiError(401, 'wrong_credential'));
		await expect(finishing).rejects.toThrow(WrongRecoveryKeyError);
		await abandoning;

		expect(callOrder(api)).toEqual(['rekey', 'logout']);
		expect(session.status).toBe('locked');
	});

	it('abandon after a finished recovery leaves the session alone', async () => {
		await recovery.finish(NEW_PASSPHRASE);
		await recovery.abandon();

		expect(api.logout).not.toHaveBeenCalled();
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
	});

	it('abandon survives a logout the server refuses', async () => {
		api.logout.mockRejectedValue(new ApiError(401, 'unauthorized'));
		await expect(recovery.abandon()).resolves.toBeUndefined();
	});
});
