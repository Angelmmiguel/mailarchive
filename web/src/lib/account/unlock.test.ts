import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Bytes } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
import { InvalidKdfParamsError, PassphraseTooShortError } from '$lib/crypto/kdf';
import { ManifestFormatError } from '$lib/crypto/manifest';
import { persistDek, STORAGE_KEY } from '$lib/crypto/persist';
import { session } from '$lib/state/session.svelte';
import {
	callOrder,
	createTestAccount,
	mockApi,
	PASSPHRASE,
	tinyDeps,
	type MockApi,
	type TestAccount
} from '$lib/testing/account';
import { fakeStorage } from '$lib/testing/storage';
import {
	NotSetUpError,
	RateLimitedError,
	ServerUnreachableError,
	MissingManifestError,
	SessionExpiredError,
	WrongPassphraseError
} from './errors';
import { lock, resume, unlock } from './unlock';

let api: MockApi;
let storage: Storage;
let account: TestAccount;
let serverKey: Bytes | null;

beforeEach(() => {
	session.lock();
	storage = fakeStorage();
	vi.stubGlobal('sessionStorage', storage);
	account = createTestAccount();
	serverKey = null;
	api = mockApi();
	api.kdf.mockResolvedValue(account.kdf);
	api.login.mockResolvedValue(undefined);
	api.getManifest.mockResolvedValue({ data: account.manifest, etag: account.etag });
	api.putSessionKey.mockImplementation(async (key) => {
		serverKey = Uint8Array.from(key);
	});
	api.getSessionKey.mockImplementation(async () => serverKey);
	api.health.mockResolvedValue({ status: 'ok', setup: true });
	api.logout.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('unlock', () => {
	it('fetches the kdf, logs in, opens the manifest and persists', async () => {
		await unlock(PASSPHRASE, tinyDeps(api));

		expect(callOrder(api)).toEqual(['kdf', 'login', 'getManifest', 'putSessionKey']);
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
		expect(session.manifest).toEqual({
			header: account.header,
			body: account.body,
			etag: account.etag
		});
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('logs in with the passphrase auth key', async () => {
		let sent: Bytes | null = null;
		api.login.mockImplementation(async (key) => {
			sent = Uint8Array.from(key);
		});

		await unlock(PASSPHRASE, tinyDeps(api));

		expect(sent).toEqual(account.authKey);
	});

	it('rejects a wrong passphrase at login, before the manifest', async () => {
		api.login.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(unlock('not the passphrase', tinyDeps(api))).rejects.toThrow(WrongPassphraseError);
		expect(callOrder(api)).toEqual(['kdf', 'login']);
		expect(session.status).toBe('locked');
	});

	it('rejects a short passphrase before touching the server', async () => {
		await expect(unlock('short', tinyDeps(api))).rejects.toThrow(PassphraseTooShortError);
		expect(callOrder(api)).toEqual([]);
	});

	it('reports an archive without an account', async () => {
		api.kdf.mockRejectedValue(new ApiError(409, 'not_setup'));

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(NotSetUpError);
		expect(callOrder(api)).toEqual(['kdf']);
	});

	it('refuses hostile kdf parameters without deriving or logging in', async () => {
		api.kdf.mockResolvedValue({ ...account.kdf, m: 1, t: 1 });

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(InvalidKdfParamsError);
		expect(callOrder(api)).toEqual(['kdf']);
	});

	it('reports rate limiting', async () => {
		api.login.mockRejectedValue(new ApiError(429, 'rate_limited'));

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(RateLimitedError);
	});

	it('reports an unreachable server', async () => {
		api.kdf.mockRejectedValue(new TypeError('fetch failed'));

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(ServerUnreachableError);
	});

	it('reports a session that died before the manifest was fetched', async () => {
		api.getManifest.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(SessionExpiredError);
		expect(callOrder(api)).toEqual(['kdf', 'login', 'getManifest']);
		expect(session.status).toBe('locked');
	});

	it('reports an account that has no manifest', async () => {
		api.getManifest.mockResolvedValue(null);

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(MissingManifestError);
		expect(session.status).toBe('locked');
	});

	it('rejects a manifest that does not decode', async () => {
		api.getManifest.mockResolvedValue({ data: new Uint8Array([1, 2, 3]), etag: '"x"' });

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(ManifestFormatError);
		expect(session.status).toBe('locked');
	});

	it('rejects a manifest whose wrapped key does not belong to this passphrase', async () => {
		const other = createTestAccount('some other passphrase');
		api.getManifest.mockResolvedValue({ data: other.manifest, etag: '"x"' });

		await expect(unlock(PASSPHRASE, tinyDeps(api))).rejects.toThrow(SealError);
		expect(session.status).toBe('locked');
	});

	it('stays unlocked when the session key cannot be stored', async () => {
		api.putSessionKey.mockRejectedValue(new ApiError(500, 'internal'));

		await unlock(PASSPHRASE, tinyDeps(api));

		expect(session.status).toBe('unlocked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe('resume', () => {
	it('reports locked when nothing is stored and the archive is set up', async () => {
		await expect(resume(tinyDeps(api))).resolves.toBe('locked');
		expect(callOrder(api)).toEqual(['health']);
		expect(session.status).toBe('locked');
	});

	it('reports not_set_up when nothing is stored and the archive is empty', async () => {
		api.health.mockResolvedValue({ status: 'ok', setup: false });

		await expect(resume(tinyDeps(api))).resolves.toBe('not_set_up');
	});

	it('clears the blob and reports locked when the session is gone', async () => {
		await persistDek(account.dek, api);
		api.getSessionKey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(resume(tinyDeps(api))).resolves.toBe('locked');
		expect(callOrder(api)).toEqual(['putSessionKey', 'getSessionKey', 'health']);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		expect(session.status).toBe('locked');
	});

	it('reopens the session without the passphrase', async () => {
		await persistDek(account.dek, api);

		await expect(resume(tinyDeps(api))).resolves.toBe('unlocked');
		expect(callOrder(api)).toEqual(['putSessionKey', 'getSessionKey', 'getManifest']);
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(account.dek);
		expect(session.manifest).toEqual({
			header: account.header,
			body: account.body,
			etag: account.etag
		});
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('survives a reload of the app after unlock', async () => {
		await unlock(PASSPHRASE, tinyDeps(api));
		session.lock();
		api.kdf.mockClear();
		api.login.mockClear();

		await expect(resume(tinyDeps(api))).resolves.toBe('unlocked');
		expect(api.kdf).not.toHaveBeenCalled();
		expect(api.login).not.toHaveBeenCalled();
		expect(session.dek).toEqual(account.dek);
	});

	it('locks and forgets the blob when the manifest cannot be opened', async () => {
		await persistDek(account.dek, api);
		api.getManifest.mockResolvedValue(null);

		await expect(resume(tinyDeps(api))).rejects.toThrow(MissingManifestError);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('reports an unreachable server', async () => {
		api.health.mockRejectedValue(new TypeError('fetch failed'));

		await expect(resume(tinyDeps(api))).rejects.toThrow(ServerUnreachableError);
	});
});

describe('lock', () => {
	it('zeroes the keys, forgets the blob and logs out', async () => {
		await unlock(PASSPHRASE, tinyDeps(api));
		const dek = session.dek;
		if (dek === null) throw new Error('unlock set no dek');

		await lock(tinyDeps(api));

		expect(api.logout).toHaveBeenCalledTimes(1);
		expect(session.status).toBe('locked');
		expect(session.dek).toBeNull();
		expect(dek).toEqual(new Uint8Array(32));
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('locks locally even if logout fails', async () => {
		await unlock(PASSPHRASE, tinyDeps(api));
		api.logout.mockRejectedValue(new TypeError('fetch failed'));

		await expect(lock(tinyDeps(api))).resolves.toBeUndefined();
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
