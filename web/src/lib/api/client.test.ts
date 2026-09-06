import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './client';
import { ApiError, type ErrorCode } from './types';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function reply(body: BodyInit | null, status: number, headers: Record<string, string> = {}) {
	fetchMock.mockResolvedValue(new Response(body, { status, headers }));
}

function replyJSON(body: unknown, status = 200, headers: Record<string, string> = {}) {
	reply(JSON.stringify(body), status, { 'Content-Type': 'application/json', ...headers });
}

function lastRequest(): { url: string; init: RequestInit } {
	const call = fetchMock.mock.calls.at(-1);
	if (call === undefined) {
		throw new Error('fetch was never called');
	}
	return { url: String(call[0]), init: call[1] ?? {} };
}

function header(name: string): string | undefined {
	const headers = lastRequest().init.headers as Record<string, string> | undefined;
	return headers?.[name];
}

const id = 'a'.repeat(64);

describe('health', () => {
	it('returns the setup flag', async () => {
		replyJSON({ status: 'ok', setup: false });

		await expect(api.health()).resolves.toEqual({ status: 'ok', setup: false });
		expect(lastRequest().url).toBe('/api/health');
	});
});

const kdf = {
	name: 'argon2id' as const,
	m: 65536,
	t: 3,
	p: 1,
	salt: Buffer.alloc(16, 2).toString('base64')
};

describe('kdf', () => {
	it('returns the raw JSON for the caller to validate', async () => {
		replyJSON(kdf);

		await expect(api.kdf()).resolves.toEqual(kdf);
		expect(lastRequest().url).toBe('/api/kdf');
	});

	it('rejects not_setup', async () => {
		replyJSON({ error: 'not_setup' }, 409);

		await expect(api.kdf()).rejects.toThrow(
			expect.objectContaining({ status: 409, code: 'not_setup' })
		);
	});
});

describe('setup and login', () => {
	const manifest = new Uint8Array([9, 8, 7]);

	it('setup sends both auth keys, the kdf and the manifest, base64 the way Go decodes it', async () => {
		const authKey = new Uint8Array(32).map((_, i) => i * 7);
		const recoveryAuthKey = new Uint8Array(32).map((_, i) => i * 11);
		reply(null, 201);

		await expect(api.setup({ authKey, recoveryAuthKey, kdf, manifest })).resolves.toBeUndefined();

		const { url, init } = lastRequest();
		expect(url).toBe('/api/setup');
		expect(init.method).toBe('POST');
		expect(header('Content-Type')).toBe('application/json');
		expect(JSON.parse(String(init.body))).toEqual({
			auth_key: Buffer.from(authKey).toString('base64'),
			recovery_auth_key: Buffer.from(recoveryAuthKey).toString('base64'),
			kdf,
			manifest: Buffer.from(manifest).toString('base64')
		});
	});

	it.each([
		{ status: 409, code: 'already_setup' },
		{ status: 400, code: 'invalid_kdf' },
		{ status: 413, code: 'too_large' }
	])('setup rejects $status as $code', async ({ status, code }) => {
		replyJSON({ error: code }, status);

		await expect(
			api.setup({ authKey: new Uint8Array(32), recoveryAuthKey: new Uint8Array(32), kdf, manifest })
		).rejects.toThrow(expect.objectContaining({ status, code }));
	});

	it('login sends the auth key base64-encoded', async () => {
		const key = new Uint8Array(32).map((_, i) => i * 7);
		reply(null, 204);

		await api.login(key);

		const { url, init } = lastRequest();
		expect(url).toBe('/api/login');
		expect(init.method).toBe('POST');
		expect(init.body).toBe(JSON.stringify({ auth_key: Buffer.from(key).toString('base64') }));
	});

	it('login accepts 204', async () => {
		reply(null, 204);

		await expect(api.login(new Uint8Array(32))).resolves.toBeUndefined();
		expect(lastRequest().url).toBe('/api/login');
	});

	it('login rejects a wrong key', async () => {
		replyJSON({ error: 'unauthorized' }, 401);

		await expect(api.login(new Uint8Array(32))).rejects.toThrow(
			expect.objectContaining({ status: 401, code: 'unauthorized' })
		);
	});

	it('logout accepts 204', async () => {
		reply(null, 204);

		await expect(api.logout()).resolves.toBeUndefined();
		expect(lastRequest()).toMatchObject({ url: '/api/logout', init: { method: 'POST' } });
	});
});

describe('manifest', () => {
	it('returns the ciphertext and the ETag', async () => {
		reply(new Uint8Array([1, 2, 3]), 200, { ETag: '"v1"' });

		await expect(api.getManifest()).resolves.toEqual({
			data: new Uint8Array([1, 2, 3]),
			etag: '"v1"'
		});
	});

	it('returns null while the archive has no manifest', async () => {
		replyJSON({ error: 'not_found' }, 404);

		await expect(api.getManifest()).resolves.toBeNull();
	});

	it('omits If-Match on the first write', async () => {
		replyJSON({ etag: '"v1"' });

		await expect(api.putManifest(new Uint8Array([1]))).resolves.toEqual({ etag: '"v1"' });
		expect(header('If-Match')).toBeUndefined();
		expect(header('Content-Type')).toBe('application/octet-stream');
	});

	it('sends If-Match on later writes', async () => {
		replyJSON({ etag: '"v2"' });

		await expect(api.putManifest(new Uint8Array([1]), '"v1"')).resolves.toEqual({ etag: '"v2"' });
		expect(header('If-Match')).toBe('"v1"');
	});

	it.each([
		{ status: 428, code: 'if_match_required' },
		{ status: 412, code: 'conflict' }
	])('rejects $status as $code', async ({ status, code }) => {
		replyJSON({ error: code }, status);

		await expect(api.putManifest(new Uint8Array([1]), '"stale"')).rejects.toThrow(
			expect.objectContaining({ status, code })
		);
	});
});

describe('rekey', () => {
	const manifest = new Uint8Array([9, 8, 7]);
	const currentAuthKey = new Uint8Array(32).map((_, i) => 200 - i);

	it('sends the current credential, the changes, the manifest and if_match in one body', async () => {
		const authKey = new Uint8Array(32).map((_, i) => i + 1);
		replyJSON({ etag: '"v2"' });

		await expect(
			api.rekey({ currentAuthKey, authKey, kdf, manifest, ifMatch: '"v1"' })
		).resolves.toEqual({ etag: '"v2"' });

		const { url, init } = lastRequest();
		expect(url).toBe('/api/rekey');
		expect(init.method).toBe('POST');
		expect(header('If-Match')).toBeUndefined();
		expect(JSON.parse(String(init.body))).toEqual({
			current_auth_key: Buffer.from(currentAuthKey).toString('base64'),
			auth_key: Buffer.from(authKey).toString('base64'),
			kdf,
			manifest: Buffer.from(manifest).toString('base64'),
			if_match: '"v1"'
		});
	});

	it('omits credentials that do not change', async () => {
		const recoveryAuthKey = new Uint8Array(32).map((_, i) => i + 1);
		replyJSON({ etag: '"v2"' });

		await api.rekey({ currentAuthKey, recoveryAuthKey, manifest, ifMatch: '"v1"' });

		expect(JSON.parse(String(lastRequest().init.body))).toEqual({
			current_auth_key: Buffer.from(currentAuthKey).toString('base64'),
			recovery_auth_key: Buffer.from(recoveryAuthKey).toString('base64'),
			manifest: Buffer.from(manifest).toString('base64'),
			if_match: '"v1"'
		});
	});

	it.each([
		{ status: 401, code: 'unauthorized' },
		{ status: 412, code: 'conflict' },
		{ status: 428, code: 'if_match_required' },
		{ status: 400, code: 'invalid_kdf' },
		{ status: 429, code: 'rate_limited' }
	])('rejects $status as $code', async ({ status, code }) => {
		replyJSON({ error: code }, status);

		await expect(api.rekey({ currentAuthKey, manifest, ifMatch: '"v1"' })).rejects.toThrow(
			expect.objectContaining({ status, code })
		);
	});

	it('rejects an answer without an etag', async () => {
		replyJSON({});

		await expect(api.rekey({ currentAuthKey, manifest, ifMatch: '"v1"' })).rejects.toThrow(
			expect.objectContaining({ code: 'malformed' })
		);
	});
});

describe('session key', () => {
	const key = new Uint8Array(32).map((_, i) => 255 - i);

	it('is stored with PUT as base64', async () => {
		reply(null, 204);

		await expect(api.putSessionKey(key)).resolves.toBeUndefined();

		const { url, init } = lastRequest();
		expect(url).toBe('/api/session/key');
		expect(init.method).toBe('PUT');
		expect(init.body).toBe(JSON.stringify({ key: Buffer.from(key).toString('base64') }));
	});

	it('rejects invalid_session_key', async () => {
		replyJSON({ error: 'invalid_session_key' }, 400);

		await expect(api.putSessionKey(new Uint8Array(3))).rejects.toThrow(
			expect.objectContaining({ status: 400, code: 'invalid_session_key' })
		);
	});

	it('is fetched back as bytes', async () => {
		replyJSON({ key: Buffer.from(key).toString('base64') });

		await expect(api.getSessionKey()).resolves.toEqual(key);
		expect(lastRequest()).toMatchObject({ url: '/api/session/key' });
	});

	it('is null when none was stored', async () => {
		replyJSON({ error: 'not_found' }, 404);

		await expect(api.getSessionKey()).resolves.toBeNull();
	});

	it('rejects a session that expired', async () => {
		replyJSON({ error: 'unauthorized' }, 401);

		await expect(api.getSessionKey()).rejects.toThrow(
			expect.objectContaining({ status: 401, code: 'unauthorized' })
		);
	});

	it.each([{ key: 5 }, { key: 'not base64!' }, [], null])(
		'rejects a malformed body %j',
		async (body) => {
			replyJSON(body);

			await expect(api.getSessionKey()).rejects.toThrow(
				expect.objectContaining({ code: 'malformed' })
			);
		}
	);
});

describe('blobs', () => {
	it('gets a blob as bytes', async () => {
		reply(new Uint8Array([7, 8]), 200);

		await expect(api.getBlob(id)).resolves.toEqual(new Uint8Array([7, 8]));
		expect(lastRequest().url).toBe(`/api/blobs/${id}`);
	});

	it('returns null for a missing blob', async () => {
		replyJSON({ error: 'not_found' }, 404);

		await expect(api.getBlob(id)).resolves.toBeNull();
	});

	it.each([
		{ status: 200, want: true },
		{ status: 404, want: false }
	])('head reports $want for $status', async ({ status, want }) => {
		reply(null, status);

		await expect(api.headBlob(id)).resolves.toBe(want);
		expect(lastRequest().init.method).toBe('HEAD');
	});

	it('reports a stored blob', async () => {
		reply(null, 201);

		await expect(api.putBlob(id, new Uint8Array([1]))).resolves.toBe('created');
		expect(lastRequest().init.method).toBe('PUT');
	});

	// Blobs are write-once, so a taken id is an ordinary answer, not a failure.
	it('reports a taken id instead of throwing', async () => {
		replyJSON({ error: 'exists' }, 409);

		await expect(api.putBlob(id, new Uint8Array([1]))).resolves.toBe('exists');
	});

	it('rejects an invalid id', async () => {
		replyJSON({ error: 'invalid_id' }, 400);

		await expect(api.putBlob('nope', new Uint8Array([1]))).rejects.toThrow(
			expect.objectContaining({ status: 400, code: 'invalid_id' })
		);
	});

	it('batches existence checks', async () => {
		replyJSON({ exists: [id] });

		await expect(api.blobsExist([id, 'b'.repeat(64)])).resolves.toEqual([id]);
		expect(lastRequest().url).toBe('/api/blobs/exists');
		expect(lastRequest().init.body).toBe(JSON.stringify({ ids: [id, 'b'.repeat(64)] }));
	});

	it('lists every id', async () => {
		replyJSON({ ids: [id] });

		await expect(api.listBlobs()).resolves.toEqual([id]);
		expect(lastRequest().url).toBe('/api/blobs');
	});
});

describe('errors', () => {
	it('carries the server code', async () => {
		replyJSON({ error: 'rate_limited' }, 429);

		const error = await api.login(new Uint8Array(32)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 429, code: 'rate_limited' satisfies ErrorCode });
	});

	it('falls back to unknown when the body is not JSON', async () => {
		reply('<html>502 from a proxy</html>', 502, { 'Content-Type': 'text/html' });

		await expect(api.health()).rejects.toThrow(
			expect.objectContaining({ status: 502, code: 'unknown' })
		);
	});
});

describe('every request', () => {
	it('is same-origin, relative and uncached', async () => {
		replyJSON({ status: 'ok', setup: true });

		await api.health();

		const { url, init } = lastRequest();
		expect(url.startsWith('/api/')).toBe(true);
		expect(init.credentials).toBe('same-origin');
		expect(init.cache).toBe('no-store');
	});
});
