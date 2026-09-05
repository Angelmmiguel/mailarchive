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

describe('setup and login', () => {
	it('send the auth key base64-encoded the way Go decodes it', async () => {
		const key = new Uint8Array(32).map((_, i) => i * 7);
		reply(null, 201);

		await api.setup(key);

		const { url, init } = lastRequest();
		expect(url).toBe('/api/setup');
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
