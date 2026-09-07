/**
 * Rekeying: the doc's Rekey flow. New credentials and the rebuilt manifest
 * go to the server in one call under the manifest's ETag, together with a
 * credential that is valid right now, so a failure leaves the old
 * credentials fully working and a stolen session cookie alone cannot
 * rotate anything.
 */
import type { Credentials } from '$lib/api/client';
import { encodeBase64 } from '$lib/api/encoding';
import type { Bytes } from '$lib/api/types';
import { expandRoot, normalizePassphrase } from '$lib/crypto/kdf';
import { deriveSubkeys, wrapDek, zeroSubkeys } from '$lib/crypto/keys';
import { encodeManifest, MANIFEST_VERSION, type ManifestHeader } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';
import { formatRecoveryKey, generateRecoveryKey } from '$lib/crypto/recovery';
import { session, type SessionManifest } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { callAs, LockedError, WrongPassphraseError } from './errors';

/** Which credentials to replace; whatever is omitted is kept as it is. */
export interface Change {
	passphrase?: string;
	recoveryKey?: Bytes;
}

/**
 * Rewraps the DEK for the changed credentials, rebuilds the manifest header
 * over the unchanged body and sends both to the server, presenting
 * `currentAuthKey` as proof of the caller. Returns the manifest as it now is
 * on the server. The caller owns `currentAuthKey` and zeroes it; the API
 * errors are left to the caller too, which wraps this in `callAs` since it
 * knows what credential it presented.
 *
 * Works on a private copy of the DEK: a lock while the new passphrase is
 * being derived zeroes the session's buffer in place, and a manifest
 * sealed under zeros would lose the archive.
 */
export async function rekey(
	deps: Deps,
	sessionDek: Bytes,
	current: SessionManifest,
	change: Change,
	currentAuthKey: Bytes
): Promise<SessionManifest> {
	const dek = Uint8Array.from(sessionDek);
	try {
		return await rekeyWith(deps, dek, current, change, currentAuthKey);
	} finally {
		zero(dek);
	}
}

async function rekeyWith(
	deps: Deps,
	dek: Bytes,
	current: SessionManifest,
	change: Change,
	currentAuthKey: Bytes
): Promise<SessionManifest> {
	const credentials: Partial<Credentials> = {};
	const wrapped = { ...current.header.wrapped };
	if (change.passphrase !== undefined) {
		credentials.kdf = deps.newKdfParams();
		const root = await deps.deriveRoot(change.passphrase, credentials.kdf);
		const { kek, authKey } = expandRoot(root);
		zero(root);
		wrapped.passphrase = encodeBase64(wrapDek(dek, kek, 'passphrase'));
		zero(kek);
		credentials.authKey = authKey;
	}
	if (change.recoveryKey !== undefined) {
		const { kek, authKey } = expandRoot(change.recoveryKey);
		wrapped.recovery = encodeBase64(wrapDek(dek, kek, 'recovery'));
		zero(kek);
		credentials.recoveryAuthKey = authKey;
	}
	const header: ManifestHeader = {
		version: MANIFEST_VERSION,
		kdf: credentials.kdf ?? current.header.kdf,
		wrapped
	};
	const keys = deriveSubkeys(dek);
	const manifest = encodeManifest({ header, body: current.body }, keys.manifest);
	zeroSubkeys(keys);
	try {
		const { etag } = await deps.api.rekey({
			...credentials,
			currentAuthKey,
			manifest,
			ifMatch: current.etag
		});
		return { header, body: current.body, etag };
	} finally {
		if (credentials.authKey) zero(credentials.authKey);
		if (credentials.recoveryAuthKey) zero(credentials.recoveryAuthKey);
	}
}

/**
 * Replaces the passphrase, with a fresh salt. The recovery key stays valid.
 * The current passphrase is what the server verifies before it rotates
 * anything; a wrong one surfaces as `WrongPassphraseError`.
 */
export async function changePassphrase(
	currentPassphrase: string,
	newPassphrase: string,
	deps: Deps = defaultDeps
): Promise<void> {
	normalizePassphrase(currentPassphrase);
	normalizePassphrase(newPassphrase);
	const { dek, manifest } = unlocked();
	const currentAuthKey = await currentCredential(deps, currentPassphrase, manifest);
	try {
		stillOpen(dek);
		const updated = await callAs(
			rekey(deps, dek, manifest, { passphrase: newPassphrase }, currentAuthKey),
			() => new WrongPassphraseError(),
			'wrong_credential'
		);
		stillOpen(dek);
		session.manifest = updated;
	} finally {
		zero(currentAuthKey);
	}
}

/**
 * Replaces the recovery key and returns its phrase. The passphrase stays
 * valid, and is what the server verifies before it rotates anything.
 */
export async function regenerateRecoveryKey(
	currentPassphrase: string,
	deps: Deps = defaultDeps
): Promise<{ recoveryPhrase: string }> {
	normalizePassphrase(currentPassphrase);
	const { dek, manifest } = unlocked();
	const currentAuthKey = await currentCredential(deps, currentPassphrase, manifest);
	const recoveryKey = generateRecoveryKey();
	try {
		stillOpen(dek);
		const updated = await callAs(
			rekey(deps, dek, manifest, { recoveryKey }, currentAuthKey),
			() => new WrongPassphraseError(),
			'wrong_credential'
		);
		stillOpen(dek);
		session.manifest = updated;
		return { recoveryPhrase: formatRecoveryKey(recoveryKey) };
	} finally {
		zero(currentAuthKey, recoveryKey);
	}
}

/**
 * The auth key of the passphrase in use, derived with the parameters the
 * manifest records for it: those are what the server stores, so any other
 * salt would derive a key it has never seen. The KEK that comes with it is
 * not needed and is zeroed at once.
 */
async function currentCredential(
	deps: Deps,
	passphrase: string,
	manifest: SessionManifest
): Promise<Bytes> {
	const root = await deps.deriveRoot(passphrase, manifest.header.kdf);
	const { kek, authKey } = expandRoot(root);
	zero(root, kek);
	return authKey;
}

/**
 * The flow awaits a derivation and a request; a lock meanwhile means the
 * result must not be sent, or stored in a session that is now closed.
 */
function stillOpen(dek: Bytes): void {
	if (session.status !== 'unlocked' || session.dek !== dek) throw new LockedError();
}

function unlocked(): { dek: Bytes; manifest: SessionManifest } {
	if (session.status !== 'unlocked' || session.dek === null || session.manifest === null) {
		throw new LockedError();
	}
	return { dek: session.dek, manifest: session.manifest };
}
