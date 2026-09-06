import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { fakeStorage } from '$lib/testing/storage';
import { generateDek } from './keys';
import {
	clearPersistedDek,
	persistDek,
	resumeDek,
	STORAGE_KEY,
	type SessionKeyApi
} from './persist';

let storage: Storage;
let serverKey: Bytes | null;
let api: {
	putSessionKey: ReturnType<typeof vi.fn>;
	getSessionKey: ReturnType<typeof vi.fn>;
} & SessionKeyApi;

beforeEach(() => {
	storage = fakeStorage();
	vi.stubGlobal('sessionStorage', storage);
	serverKey = null;
	api = {
		// The caller zeroes its buffer afterwards, so a fake server must copy.
		putSessionKey: vi.fn(async (key: Bytes) => {
			serverKey = Uint8Array.from(key);
		}),
		getSessionKey: vi.fn(async () => serverKey)
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('persistDek', () => {
	it('hands the server a 32-byte key and stores only ciphertext', async () => {
		const dek = generateDek();

		await persistDek(dek, api);

		expect(api.putSessionKey).toHaveBeenCalledTimes(1);
		expect(serverKey).toHaveLength(32);
		const stored = storage.getItem(STORAGE_KEY);
		expect(stored).not.toBeNull();
		expect(stored).not.toContain(encodeBase64(dek));
		expect(Buffer.from(String(stored), 'base64')).toHaveLength(32 + 41);
	});

	it('zeroes the session key it sent', async () => {
		await persistDek(generateDek(), api);

		const sent = api.putSessionKey.mock.calls[0]?.[0];
		expect(sent).toEqual(new Uint8Array(32));
	});

	it('stores nothing if the server refuses the key', async () => {
		api.putSessionKey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(persistDek(generateDek(), api)).rejects.toThrow(ApiError);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe('resumeDek', () => {
	it('round-trips through the server half', async () => {
		const dek = generateDek();
		await persistDek(dek, api);

		await expect(resumeDek(api)).resolves.toEqual(dek);
		expect(api.getSessionKey).toHaveBeenCalledTimes(1);
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});

	it('is null without asking the server when nothing is stored', async () => {
		await expect(resumeDek(api)).resolves.toBeNull();
		expect(api.getSessionKey).not.toHaveBeenCalled();
	});

	it('clears the blob when the session is gone', async () => {
		await persistDek(generateDek(), api);
		api.getSessionKey.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(resumeDek(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears the blob when the server holds no key', async () => {
		await persistDek(generateDek(), api);
		serverKey = null;

		await expect(resumeDek(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears a blob that does not open', async () => {
		await persistDek(generateDek(), api);
		const stored = Buffer.from(String(storage.getItem(STORAGE_KEY)), 'base64');
		stored[stored.length - 1] ^= 0x01;
		storage.setItem(STORAGE_KEY, stored.toString('base64'));

		await expect(resumeDek(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('clears a blob that is not even base64', async () => {
		serverKey = new Uint8Array(32);
		storage.setItem(STORAGE_KEY, 'garbage!');

		await expect(resumeDek(api)).resolves.toBeNull();
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('propagates other failures and keeps the blob', async () => {
		await persistDek(generateDek(), api);
		api.getSessionKey.mockRejectedValue(new TypeError('fetch failed'));

		await expect(resumeDek(api)).rejects.toThrow(TypeError);
		expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
	});
});

describe('clearPersistedDek', () => {
	it('removes the blob', async () => {
		await persistDek(generateDek(), api);

		clearPersistedDek();

		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
