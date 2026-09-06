/**
 * Surviving a page refresh without the passphrase. The DEK is stored in
 * sessionStorage sealed under a random session key that lives only in the
 * server's memory: the disk holds ciphertext, the server holds a key, and
 * neither half is useful alone. Logout or expiry deletes the server half.
 */
import * as client from '$lib/api/client';
import { decodeBase64, encodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { unwrapDek, wrapDek } from './keys';
import { randomBytes, zero } from './random';

export const STORAGE_KEY = 'mailarchive.dek';
export const SESSION_KEY_LENGTH = 32;

/** The two routes this module needs, so tests can hand in fakes. */
export type SessionKeyApi = Pick<typeof client, 'putSessionKey' | 'getSessionKey'>;

/** Hands a fresh session key to the server and stores the DEK sealed under it. */
export async function persistDek(dek: Uint8Array, api: SessionKeyApi): Promise<void> {
	const sessionKey = randomBytes(SESSION_KEY_LENGTH);
	try {
		await api.putSessionKey(sessionKey);
		sessionStorage.setItem(STORAGE_KEY, encodeBase64(wrapDek(dek, sessionKey, 'session')));
	} finally {
		zero(sessionKey);
	}
}

/**
 * Recovers the DEK after a reload, or returns null when there is nothing
 * stored or the server no longer holds the session key. Anything that fails
 * to unwrap is discarded, since it can never open again.
 */
export async function resumeDek(api: SessionKeyApi): Promise<Bytes | null> {
	const stored = sessionStorage.getItem(STORAGE_KEY);
	if (stored === null) return null;

	let sessionKey: Bytes | null;
	try {
		sessionKey = await api.getSessionKey();
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) {
			clearPersistedDek();
			return null;
		}
		throw e;
	}
	if (sessionKey === null) {
		clearPersistedDek();
		return null;
	}

	try {
		return unwrapDek(decodeBase64(stored), sessionKey, 'session');
	} catch {
		// A stored value that is not base64, or a SealError: either way the
		// blob will never open again, so it is not worth keeping.
		clearPersistedDek();
		return null;
	} finally {
		zero(sessionKey);
	}
}

/** Forgets the sealed DEK. */
export function clearPersistedDek(): void {
	sessionStorage.removeItem(STORAGE_KEY);
}
