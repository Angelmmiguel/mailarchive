import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import { deriveSubkeys } from '$lib/crypto/keys';
import { decodeManifestBody, decodeManifestHeader } from '$lib/crypto/manifest';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, tinyDeps, type MockApi } from '$lib/testing/account';
import { LockedError, SessionExpiredError } from './errors';
import { saveSettings } from './settings';

let api: MockApi;

beforeEach(() => {
	session.lock();
	api = mockApi();
});

describe('saveSettings', () => {
	it('re-seals the body under the ETag and updates the session', async () => {
		const account = createTestAccount();
		session.unlock(Uint8Array.from(account.dek), {
			header: account.header,
			body: account.body,
			etag: '"v1"'
		});
		api.putManifest.mockResolvedValue({ etag: '"v2"' });

		await saveSettings({ ownAddresses: ['a@example.com', 'b@example.org'] }, tinyDeps(api));

		expect(api.putManifest).toHaveBeenCalledTimes(1);
		const [data, ifMatch] = api.putManifest.mock.calls[0] ?? [];
		if (data === undefined) throw new Error('not called');
		expect(ifMatch).toBe('"v1"');
		expect(decodeManifestHeader(data)).toEqual(account.header);
		expect(decodeManifestBody(data, deriveSubkeys(account.dek).manifest)).toEqual({
			settings: { ownAddresses: ['a@example.com', 'b@example.org'] },
			segments: account.body.segments
		});
		expect(session.manifest).toEqual({
			header: account.header,
			body: {
				settings: { ownAddresses: ['a@example.com', 'b@example.org'] },
				segments: account.body.segments
			},
			etag: '"v2"'
		});
	});

	it('refuses while locked', async () => {
		await expect(saveSettings({ ownAddresses: [] }, tinyDeps(api))).rejects.toThrow(LockedError);
		expect(api.putManifest).not.toHaveBeenCalled();
	});

	it('keeps the session manifest when the write fails', async () => {
		const account = createTestAccount();
		session.unlock(Uint8Array.from(account.dek), {
			header: account.header,
			body: account.body,
			etag: '"v1"'
		});
		api.putManifest.mockRejectedValue(new ApiError(401, 'unauthorized'));

		await expect(saveSettings({ ownAddresses: [] }, tinyDeps(api))).rejects.toThrow(
			SessionExpiredError
		);
		expect(session.manifest?.body).toEqual(account.body);
		expect(session.manifest?.etag).toBe('"v1"');
	});
});
