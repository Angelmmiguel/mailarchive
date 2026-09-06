/**
 * Unlock, resume and lock: the doc's flows of the same names.
 */
import type { Bytes, Manifest } from '$lib/api/types';
import { decodeBase64 } from '$lib/api/encoding';
import { expandRoot, normalizePassphrase, parseKdfParams } from '$lib/crypto/kdf';
import { deriveSubkeys, unwrapDek, zeroSubkeys } from '$lib/crypto/keys';
import { decodeManifestBody, decodeManifestHeader } from '$lib/crypto/manifest';
import { clearPersistedDek, persistDek, resumeDek } from '$lib/crypto/persist';
import { zero } from '$lib/crypto/random';
import { session, type SessionManifest } from '$lib/state/session.svelte';
import { defaultDeps, type Api, type Deps } from './deps';
import { call, callAs, MissingManifestError, WrongPassphraseError } from './errors';

/**
 * Derives the keys, logs in and opens the manifest. A wrong passphrase is
 * rejected at login, before the manifest is ever fetched.
 */
export async function unlock(passphrase: string, deps: Deps = defaultDeps): Promise<void> {
	normalizePassphrase(passphrase);
	const params = parseKdfParams(await call(deps.api.kdf()));
	const root = await deps.deriveRoot(passphrase, params);
	const { kek, authKey } = expandRoot(root);
	zero(root);
	let dek: Bytes;
	try {
		await callAs(deps.api.login(authKey), () => new WrongPassphraseError(), 'unauthorized');
		const manifest = await requireManifest(deps.api);
		const header = decodeManifestHeader(manifest.data);
		dek = unwrapDek(decodeBase64(header.wrapped.passphrase), kek, 'passphrase');
		session.unlock(dek, openManifest(dek, manifest));
	} finally {
		zero(kek, authKey);
	}
	await remember(dek, deps.api);
}

/**
 * Page load: reopens the session from the sealed DEK in sessionStorage if
 * the server still holds the session key, otherwise reports what screen to
 * show.
 */
export async function resume(
	deps: Deps = defaultDeps
): Promise<'unlocked' | 'locked' | 'not_set_up'> {
	const dek = await call(resumeDek(deps.api));
	if (dek === null) {
		const { setup } = await call(deps.api.health());
		return setup ? 'locked' : 'not_set_up';
	}
	try {
		session.unlock(dek, openManifest(dek, await requireManifest(deps.api)));
	} catch (e) {
		zero(dek);
		clearPersistedDek();
		throw e;
	}
	return 'unlocked';
}

/**
 * Zeroes the keys, forgets the sealed DEK and revokes the session. Local
 * state goes first so that locking never waits on the network; a logout that
 * fails changes nothing here, and the server's session expires on its own.
 */
export async function lock(deps: Deps = defaultDeps): Promise<void> {
	session.lock();
	clearPersistedDek();
	try {
		await deps.api.logout();
	} catch {
		// See above.
	}
}

/**
 * Fetches the manifest of an account that must have one. Setup stores the
 * manifest before the credentials exist, so an account without one has lost
 * it since, and with it the wrapped DEK.
 */
export async function requireManifest(api: Api): Promise<Manifest> {
	const manifest = await call(api.getManifest());
	if (manifest === null) throw new MissingManifestError();
	return manifest;
}

/** Decodes both layers of a fetched manifest with the DEK. */
export function openManifest(dek: Bytes, manifest: Manifest): SessionManifest {
	const keys = deriveSubkeys(dek);
	try {
		return {
			header: decodeManifestHeader(manifest.data),
			body: decodeManifestBody(manifest.data, keys.manifest),
			etag: manifest.etag
		};
	} finally {
		zeroSubkeys(keys);
	}
}

/**
 * Stores the DEK for page reloads. Best effort: by the time this runs the
 * session is unlocked and, for setup and recovery, a new recovery phrase is
 * waiting to be shown, so a failure here must not be reported as a failure of
 * the whole flow. Without it the next reload simply asks for the passphrase.
 */
export async function remember(dek: Bytes, api: Api): Promise<void> {
	try {
		await persistDek(dek, api);
	} catch {
		clearPersistedDek();
	}
}
