/**
 * Typed client for the mailarchive API. It mirrors the Go routes one for one
 * and knows nothing about crypto: bodies are opaque bytes on the way in and on
 * the way out.
 */
import {
	ApiError,
	type Bytes,
	type ErrorCode,
	type Health,
	type Manifest,
	type PutBlobResult
} from './types';

const octetStream = 'application/octet-stream';

/**
 * Encodes bytes the way Go's base64.StdEncoding does, which is what the server
 * expects for an auth key: standard alphabet, with padding.
 */
export function encodeBase64(bytes: Bytes): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Reports liveness and whether the archive has an account yet. */
export async function health(): Promise<Health> {
	const res = await send('/health');
	if (!res.ok) return fail(res);
	return (await res.json()) as Health;
}

/** Creates the archive's single account. Fails with `already_setup` if it exists. */
export async function setup(authKey: Bytes): Promise<void> {
	const res = await sendKey('/setup', authKey);
	if (!res.ok) await fail(res);
}

/** Exchanges the auth key for a session cookie. */
export async function login(authKey: Bytes): Promise<void> {
	const res = await sendKey('/login', authKey);
	if (!res.ok) await fail(res);
}

/** Revokes the current session. */
export async function logout(): Promise<void> {
	const res = await send('/logout', { method: 'POST' });
	if (!res.ok) await fail(res);
}

/** Returns the encrypted manifest, or null while the archive has none. */
export async function getManifest(): Promise<Manifest | null> {
	const res = await send('/manifest');
	if (res.status === 404) return null;
	if (!res.ok) return fail(res);
	return { data: await bytes(res), etag: res.headers.get('ETag') ?? '' };
}

/**
 * Replaces the manifest and returns its new ETag. Omitting `ifMatch` is only
 * valid for the very first manifest; afterwards the server answers
 * `if_match_required`, and a stale ETag answers `conflict`.
 */
export async function putManifest(data: Bytes, ifMatch?: string): Promise<{ etag: string }> {
	const headers: Record<string, string> = { 'Content-Type': octetStream };
	if (ifMatch !== undefined) {
		headers['If-Match'] = ifMatch;
	}
	const res = await send('/manifest', { method: 'PUT', headers, body: data });
	if (!res.ok) return fail(res);
	return (await res.json()) as { etag: string };
}

/** Returns a blob, or null if the id is not stored. */
export async function getBlob(id: string): Promise<Bytes | null> {
	const res = await send(blobPath(id));
	if (res.status === 404) return null;
	if (!res.ok) return fail(res);
	return bytes(res);
}

/** Reports whether a blob is stored, without downloading it. */
export async function headBlob(id: string): Promise<boolean> {
	const res = await send(blobPath(id), { method: 'HEAD' });
	if (res.status === 404) return false;
	if (!res.ok) return fail(res);
	return true;
}

/**
 * Stores a blob. Blobs are write-once, so a taken id is a normal outcome and
 * reported as 'exists' rather than thrown.
 */
export async function putBlob(id: string, data: Bytes): Promise<PutBlobResult> {
	const res = await send(blobPath(id), {
		method: 'PUT',
		headers: { 'Content-Type': octetStream },
		body: data
	});
	if (res.status === 409) return 'exists';
	if (!res.ok) return fail(res);
	return 'created';
}

/** Returns the subset of `ids` the server already stores. */
export async function blobsExist(ids: string[]): Promise<string[]> {
	const res = await send('/blobs/exists', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ids })
	});
	if (!res.ok) return fail(res);
	return ((await res.json()) as { exists: string[] }).exists;
}

/** Returns every stored blob id. */
export async function listBlobs(): Promise<string[]> {
	const res = await send('/blobs');
	if (!res.ok) return fail(res);
	return ((await res.json()) as { ids: string[] }).ids;
}

function blobPath(id: string): string {
	return `/blobs/${encodeURIComponent(id)}`;
}

function send(path: string, init: RequestInit = {}): Promise<Response> {
	// Relative URLs keep every request same-origin, in development through the
	// Vite proxy and in production against the Go binary that serves this app.
	return fetch(`/api${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' });
}

function sendKey(path: string, authKey: Bytes): Promise<Response> {
	return send(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ auth_key: encodeBase64(authKey) })
	});
}

async function bytes(res: Response): Promise<Bytes> {
	return new Uint8Array(await res.arrayBuffer());
}

async function fail(res: Response): Promise<never> {
	throw new ApiError(res.status, await errorCode(res));
}

async function errorCode(res: Response): Promise<ErrorCode> {
	try {
		const parsed: unknown = await res.json();
		if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
			const code = (parsed as { error: unknown }).error;
			if (typeof code === 'string') {
				return code as ErrorCode;
			}
		}
	} catch {
		// An error body that is not JSON carries no code; the status is all
		// the caller gets.
	}
	return 'unknown';
}
