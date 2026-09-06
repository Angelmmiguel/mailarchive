/**
 * Fixtures for the account flows: a fully mocked API client, a derive with
 * parameters small enough to run in milliseconds, and an account built with
 * that derive so tests can check what a flow sends against real keys.
 */
import { vi, type Mock } from 'vitest';
import type { Api, Deps } from '$lib/account/deps';
import { encodeBase64 } from '$lib/api/encoding';
import type { Bytes } from '$lib/api/types';
import { deriveRoot, expandRoot, newKdfParams, type KdfParams } from '$lib/crypto/kdf';
import { deriveSubkeys, generateDek, wrapDek } from '$lib/crypto/keys';
import {
	encodeManifest,
	MANIFEST_VERSION,
	type ManifestBody,
	type ManifestHeader
} from '$lib/crypto/manifest';
import { formatRecoveryKey, generateRecoveryKey } from '$lib/crypto/recovery';

export type MockApi = { [K in keyof Api]: Mock<Api[K]> };

/** Every route as an unconfigured mock; each test sets what it needs. */
export function mockApi(): MockApi {
	return {
		health: vi.fn<Api['health']>(),
		kdf: vi.fn<Api['kdf']>(),
		setup: vi.fn<Api['setup']>(),
		login: vi.fn<Api['login']>(),
		logout: vi.fn<Api['logout']>(),
		rekey: vi.fn<Api['rekey']>(),
		putSessionKey: vi.fn<Api['putSessionKey']>(),
		getSessionKey: vi.fn<Api['getSessionKey']>(),
		getManifest: vi.fn<Api['getManifest']>(),
		putManifest: vi.fn<Api['putManifest']>(),
		getBlob: vi.fn<Api['getBlob']>(),
		headBlob: vi.fn<Api['headBlob']>(),
		putBlob: vi.fn<Api['putBlob']>(),
		blobsExist: vi.fn<Api['blobsExist']>(),
		listBlobs: vi.fn<Api['listBlobs']>()
	};
}

/** The names of the routes called, in the order they were called. */
export function callOrder(api: MockApi): string[] {
	const names = Object.keys(api) as (keyof MockApi)[];
	return names
		.flatMap((name) => api[name].mock.invocationCallOrder.map((order) => ({ name, order })))
		.sort((a, b) => a.order - b.order)
		.map((call) => call.name);
}

/** `deriveRoot` with the cost overridden to something a test can afford. */
export function tinyDerive(passphrase: string, params: KdfParams): Bytes {
	return deriveRoot(passphrase, { ...params, m: 64, t: 1, p: 1 });
}

/** Deps whose outward calls are all observable. */
export interface TinyDeps extends Deps {
	api: MockApi;
	deriveRoot: Mock<Deps['deriveRoot']>;
	newKdfParams: Mock<Deps['newKdfParams']>;
}

export function tinyDeps(api: MockApi): TinyDeps {
	return {
		api,
		deriveRoot: vi.fn<Deps['deriveRoot']>((passphrase, params) =>
			Promise.resolve(tinyDerive(passphrase, params))
		),
		newKdfParams: vi.fn<Deps['newKdfParams']>(newKdfParams)
	};
}

export const PASSPHRASE = 'correct horse battery staple';
export const NEW_PASSPHRASE = 'a brand new passphrase';

export interface TestAccount {
	dek: Bytes;
	kdf: KdfParams;
	authKey: Bytes;
	recoveryAuthKey: Bytes;
	recoveryPhrase: string;
	header: ManifestHeader;
	body: ManifestBody;
	/** The encoded manifest as the server would return it. */
	manifest: Bytes;
	etag: string;
}

/** An account as `createAccount` would have made it, with the tiny derive. */
export function createTestAccount(passphrase = PASSPHRASE): TestAccount {
	const dek = generateDek();
	const kdf = newKdfParams();
	const { kek, authKey } = expandRoot(tinyDerive(passphrase, kdf));
	const recoveryKey = generateRecoveryKey();
	const { kek: recoveryKek, authKey: recoveryAuthKey } = expandRoot(recoveryKey);
	const header: ManifestHeader = {
		version: MANIFEST_VERSION,
		kdf,
		wrapped: {
			passphrase: encodeBase64(wrapDek(dek, kek, 'passphrase')),
			recovery: encodeBase64(wrapDek(dek, recoveryKek, 'recovery'))
		}
	};
	const body: ManifestBody = {
		settings: { ownAddresses: ['me@example.com'] },
		segments: [{ id: 'f'.repeat(64), createdAt: '2026-09-01T00:00:00Z', messages: 3 }]
	};
	return {
		dek,
		kdf,
		authKey,
		recoveryAuthKey,
		recoveryPhrase: formatRecoveryKey(recoveryKey),
		header,
		body,
		manifest: encodeManifest({ header, body }, deriveSubkeys(dek).manifest),
		etag: '"v1"'
	};
}
