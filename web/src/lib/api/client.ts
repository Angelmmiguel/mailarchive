/**
 * Typed client for the mailarchive API. It mirrors the Go routes one for one
 * and knows nothing about crypto: bodies are opaque bytes on the way in and on
 * the way out.
 */
import type { KdfParams } from '$lib/crypto/kdf';
import { decodeBase64, encodeBase64 } from './encoding';
import {
	ApiError,
	type Bytes,
	type ErrorCode,
	type Health,
	type Manifest,
	type PutBlobResult
} from './types';

const octetStream = 'application/octet-stream';

/** Reports liveness and whether the archive has an account yet. */
export async function health(): Promise<Health> {
	const res = await send('/health');
	if (!res.ok) return fail(res);
	return (await res.json()) as Health;
}

/**
 * Returns the stored KDF parameters as the server sent them. They are
 * untrusted until the caller runs them through `parseKdfParams`. Fails with
 * `not_setup` while the archive has no account.
 */
export async function kdf(): Promise<unknown> {
	const res = await send('/kdf');
	if (!res.ok) return fail(res);
	return res.json();
}

/** Credentials that create the account or, in part, replace it. */
export interface Credentials {
	authKey: Bytes;
	recoveryAuthKey: Bytes;
	kdf: KdfParams;
}

/** What `setup` sends: both credentials and the first manifest. */
export interface Setup extends Credentials {
	manifest: Bytes;
}

/**
 * Creates the archive's single account together with its first manifest, in
 * one request, so an account can never exist without the wrapped DEK that
 * makes it usable. Fails with `already_setup` if an account exists. The
 * manifest's ETag is not returned; `getManifest` reports it.
 */
export async function setup({ authKey, recoveryAuthKey, kdf, manifest }: Setup): Promise<void> {
	const res = await sendJSON('/setup', {
		auth_key: encodeBase64(authKey),
		recovery_auth_key: encodeBase64(recoveryAuthKey),
		kdf,
		manifest: encodeBase64(manifest)
	});
	if (!res.ok) await fail(res);
}

/** Exchanges the auth key for a session cookie. */
export async function login(authKey: Bytes): Promise<void> {
	const res = await sendJSON('/login', { auth_key: encodeBase64(authKey) });
	if (!res.ok) await fail(res);
}

/** Revokes the current session. */
export async function logout(): Promise<void> {
	const res = await send('/logout', { method: 'POST' });
	if (!res.ok) await fail(res);
}

/** What `rekey` replaces: any subset of the credentials, always with the manifest. */
export interface Rekey extends Partial<Credentials> {
	/**
	 * A credential that is valid right now, either auth key, proving the
	 * caller is more than a session cookie. A rejected one answers 401.
	 */
	currentAuthKey: Bytes;
	manifest: Bytes;
	/** The current manifest ETag; a stale one answers `conflict`. */
	ifMatch: string;
}

/**
 * Replaces credentials and the manifest in one atomic step, so that no
 * failure leaves one passphrase logging in and another decrypting. The
 * server checks `currentAuthKey` before touching anything, under the login
 * rate limit, and on success revokes every session except the calling one.
 * Returns the manifest's new ETag.
 */
export async function rekey({
	currentAuthKey,
	authKey,
	recoveryAuthKey,
	kdf,
	manifest,
	ifMatch
}: Rekey): Promise<{ etag: string }> {
	const body: Record<string, unknown> = {
		current_auth_key: encodeBase64(currentAuthKey),
		manifest: encodeBase64(manifest),
		if_match: ifMatch
	};
	if (authKey !== undefined) body.auth_key = encodeBase64(authKey);
	if (recoveryAuthKey !== undefined) body.recovery_auth_key = encodeBase64(recoveryAuthKey);
	if (kdf !== undefined) body.kdf = kdf;
	const res = await sendJSON('/rekey', body);
	if (!res.ok) return fail(res);
	return etag(res);
}

/** Stores 32 bytes in memory on the session, replacing any previous value. */
export async function putSessionKey(key: Bytes): Promise<void> {
	const res = await sendJSON('/session/key', { key: encodeBase64(key) }, {}, 'PUT');
	if (!res.ok) await fail(res);
}

/** Returns the session's key, or null if none was stored. */
export async function getSessionKey(): Promise<Bytes | null> {
	const res = await send('/session/key');
	if (res.status === 404) return null;
	if (!res.ok) return fail(res);
	const parsed: unknown = await res.json();
	const key = field(parsed, 'key');
	if (typeof key !== 'string') throw new ApiError(res.status, 'malformed');
	try {
		return decodeBase64(key);
	} catch {
		throw new ApiError(res.status, 'malformed');
	}
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
	return etag(res);
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
	const res = await sendJSON('/blobs/exists', { ids });
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

function sendJSON(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
	method = 'POST'
): Promise<Response> {
	return send(path, {
		method,
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function bytes(res: Response): Promise<Bytes> {
	return new Uint8Array(await res.arrayBuffer());
}

async function etag(res: Response): Promise<{ etag: string }> {
	const value = field(await res.json(), 'etag');
	if (typeof value !== 'string' || value === '') throw new ApiError(res.status, 'malformed');
	return { etag: value };
}

/** Reads one property off a JSON value that may not even be an object. */
function field(value: unknown, name: string): unknown {
	if (value === null || typeof value !== 'object') return undefined;
	const record: Record<string, unknown> = { ...value };
	return record[name];
}

async function fail(res: Response): Promise<never> {
	throw new ApiError(res.status, await errorCode(res));
}

async function errorCode(res: Response): Promise<ErrorCode> {
	try {
		const code = field(await res.json(), 'error');
		if (typeof code === 'string') {
			return code as ErrorCode;
		}
	} catch {
		// An error body that is not JSON carries no code; the status is all
		// the caller gets.
	}
	return 'unknown';
}
