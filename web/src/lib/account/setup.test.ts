import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { SealError } from '$lib/crypto/aead';
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
	PASSPHRASE,
	tinyDeps,
	tinyDerive,
	type MockApi
} from '$lib/testing/account';
import { fakeStorage } from '$lib/testing/storage';
import {
	AlreadySetUpError,
	MissingManifestError,
	RateLimitedError,
	ServerUnreachableError
} from './errors';
import { createAccount } from './setup';

let api: MockApi;
let storage: Storage;

beforeEach(() => {
	session.lock();
	storage = fakeStorage();
	vi.stubGlobal('sessionStorage', storage);
	api = mockApi();
	// The server keeps the manifest setup sent and serves it back after login,
	// under an ETag of its own choosing.
	api.setup.mockImplementation(async ({ manifest }) => {
		api.getManifest.mockResolvedValue({ data: Uint8Array.from(manifest), etag: '"server-1"' });
	});
	api.login.mockResolvedValue(undefined);
	api.putSessionKey.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function argument<T extends unknown[]>(calls: T[]): T {
	const call = calls[0];
	if (call === undefined) throw new Error('not called');
	return call;
}

describe('createAccount', () => {
	it('registers with credentials and manifest in one call, logs in and unlocks', async () => {
		const { recoveryPhrase } = await createAccount(PASSPHRASE, ['me@example.com'], tinyDeps(api));

		expect(callOrder(api)).toEqual(['setup', 'login', 'getManifest', 'putSessionKey']);
		expect(api.putManifest).not.toHaveBeenCalled();

		// Setup receives two distinct 32-byte auth keys, the kdf with a fresh
		// salt and the manifest. The keys are zeroed after the call, so
		// compare against what they must have been.
		const [sent] = argument(api.setup.mock.calls);
		expect(sent.kdf).toMatchObject(DEFAULT_KDF);
		expect(decodeBase64(sent.kdf.salt)).toHaveLength(16);
		const root = expandRoot(tinyDerive(PASSPHRASE, sent.kdf));
		const recovery = expandRoot(parseRecoveryKey(recoveryPhrase));
		expect(recoveryPhrase.split(' ')).toHaveLength(24);

		// Login used the passphrase auth key, the same buffer setup received.
		const [loginKey] = argument(api.login.mock.calls);
		expect(loginKey).toBe(sent.authKey);

		// The manifest header decodes without a key, and each wrap opens.
		const header = decodeManifestHeader(sent.manifest);
		expect(header.kdf).toEqual(sent.kdf);
		const dek = unwrapDek(decodeBase64(header.wrapped.passphrase), root.kek, 'passphrase');
		expect(unwrapDek(decodeBase64(header.wrapped.recovery), recovery.kek, 'recovery')).toEqual(dek);
		expect(decodeManifestBody(sent.manifest, deriveSubkeys(dek).manifest)).toEqual({
			settings: { ownAddresses: ['me@example.com'] },
			segments: []
		});

		// The session holds the server's copy, with the ETag getManifest returned.
		expect(session.status).toBe('unlocked');
		expect(session.dek).toEqual(dek);
		expect(session.manifest).toEqual({
			header,
			body: { settings: { ownAddresses: ['me@example.com'] }, segments: [] },
			etag: '"server-1"'
		});
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('sends the auth keys the server will later be asked to verify', async () => {
		let sentAuthKey: Bytes | null = null;
		let sentRecoveryAuthKey: Bytes | null = null;
		const setup = api.setup.getMockImplementation();
		api.setup.mockImplementation(async (request) => {
			sentAuthKey = Uint8Array.from(request.authKey);
			sentRecoveryAuthKey = Uint8Array.from(request.recoveryAuthKey);
			await setup?.(request);
		});

		const { recoveryPhrase } = await createAccount(PASSPHRASE, [], tinyDeps(api));

		const [sent] = argument(api.setup.mock.calls);
		expect(sentAuthKey).toEqual(expandRoot(tinyDerive(PASSPHRASE, sent.kdf)).authKey);
		expect(sentRecoveryAuthKey).toEqual(expandRoot(parseRecoveryKey(recoveryPhrase)).authKey);
		expect(sentAuthKey).not.toEqual(sentRecoveryAuthKey);
		// And the buffers handed over were zeroed once the flow was done with them.
		expect(sent.authKey).toEqual(new Uint8Array(32));
		expect(sent.recoveryAuthKey).toEqual(new Uint8Array(32));
	});

	it('uses the injected kdf parameters', async () => {
		const deps = tinyDeps(api);
		const params: KdfParams = {
			...DEFAULT_KDF,
			m: 8192,
			t: 1,
			salt: encodeBase64(new Uint8Array(16))
		};
		deps.newKdfParams.mockReturnValue(params);

		await createAccount(PASSPHRASE, [], deps);

		expect(deps.deriveRoot).toHaveBeenCalledExactlyOnceWith(PASSPHRASE, params);
		expect(argument(api.setup.mock.calls)[0].kdf).toEqual(params);
		expect(session.manifest?.header.kdf).toEqual(params);
	});

	it('defaults to no own addresses', async () => {
		await createAccount(PASSPHRASE, undefined, tinyDeps(api));

		expect(session.manifest?.body.settings.ownAddresses).toEqual([]);
	});

	it('rejects a short passphrase before touching the server', async () => {
		await expect(createAccount('short', [], tinyDeps(api))).rejects.toThrow(
			PassphraseTooShortError
		);
		expect(callOrder(api)).toEqual([]);
	});

	it.each([
		{ code: 'already_setup', status: 409, want: AlreadySetUpError },
		{ code: 'rate_limited', status: 429, want: RateLimitedError }
	] as const)('reports $code from setup and stays locked', async ({ code, status, want }) => {
		api.setup.mockRejectedValue(new ApiError(status, code));

		await expect(createAccount(PASSPHRASE, [], tinyDeps(api))).rejects.toThrow(want);
		expect(callOrder(api)).toEqual(['setup']);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('reports an unreachable server', async () => {
		api.setup.mockRejectedValue(new TypeError('fetch failed'));

		await expect(createAccount(PASSPHRASE, [], tinyDeps(api))).rejects.toThrow(
			ServerUnreachableError
		);
	});

	// Setup is atomic on the server, so a failure after it is not a
	// half-made account: it is reported as what it is, and the passphrase
	// unlocks the account that now exists.
	it('passes a failure after setup through unchanged', async () => {
		api.login.mockRejectedValue(new TypeError('fetch failed'));

		await expect(createAccount(PASSPHRASE, [], tinyDeps(api))).rejects.toThrow(
			ServerUnreachableError
		);
		expect(callOrder(api)).toEqual(['setup', 'login']);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('reports a server that lost the manifest it just accepted', async () => {
		api.setup.mockImplementation(async () => {
			api.getManifest.mockResolvedValue(null);
		});

		await expect(createAccount(PASSPHRASE, [], tinyDeps(api))).rejects.toThrow(
			MissingManifestError
		);
		expect(session.status).toBe('locked');
	});

	it('refuses a manifest that is not the one it sent', async () => {
		api.setup.mockImplementation(async () => {
			const other = createTestAccount();
			api.getManifest.mockResolvedValue({ data: other.manifest, etag: '"other"' });
		});

		await expect(createAccount(PASSPHRASE, [], tinyDeps(api))).rejects.toThrow(SealError);
		expect(session.status).toBe('locked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('still returns the phrase when the session key cannot be stored', async () => {
		api.putSessionKey.mockRejectedValue(new ApiError(500, 'internal'));

		const { recoveryPhrase } = await createAccount(PASSPHRASE, [], tinyDeps(api));

		expect(recoveryPhrase.split(' ')).toHaveLength(24);
		expect(session.status).toBe('unlocked');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
