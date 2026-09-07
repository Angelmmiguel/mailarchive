/**
 * Recovery: the doc's Recover flow, in the two halves the screen shows.
 * The phrase logs in and opens the DEK; the account then gets a new
 * passphrase and a new recovery key, so the phrase that was just typed
 * stops working. Between the two the keys wait in memory, held by the
 * `Recovery` the first half returns, and go with it: `finish` hands the
 * DEK to the session, `abandon` zeroes everything and revokes the login.
 */
import { decodeBase64 } from '$lib/api/encoding';
import { ApiError, type Bytes } from '$lib/api/types';
import { expandRoot, normalizePassphrase } from '$lib/crypto/kdf';
import { unwrapDek } from '$lib/crypto/keys';
import { decodeManifestHeader } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from '$lib/crypto/recovery';
import { session, type SessionManifest } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { callAs, LockedError, WrongRecoveryKeyError } from './errors';
import { rekey } from './rotate';
import { openManifest, remember, requireManifest } from './unlock';

const wrong = (): Error => new WrongRecoveryKeyError();

/**
 * Logs in with the recovery phrase and opens the DEK under it. A phrase
 * that is not one is rejected before the server is asked; one the server
 * does not know surfaces as `WrongRecoveryKeyError`.
 *
 * The recovery auth key is the current credential the rekey has to
 * present, so it lives on in the `Recovery`; the recovery KEK is done as
 * soon as the DEK is open.
 */
export async function openRecovery(phrase: string, deps: Deps = defaultDeps): Promise<Recovery> {
	const recoveryKey = parseRecoveryKey(phrase);
	const { kek, authKey } = expandRoot(recoveryKey);
	zero(recoveryKey);
	let loggedIn = false;
	let dek: Bytes | null = null;
	try {
		await callAs(deps.api.login(authKey), wrong, 'unauthorized');
		loggedIn = true;
		const manifest = await requireManifest(deps.api);
		const header = decodeManifestHeader(manifest.data);
		dek = unwrapDek(decodeBase64(header.wrapped.recovery), kek, 'recovery');
		return new Recovery(deps, dek, authKey, openManifest(dek, manifest));
	} catch (e) {
		zero(authKey);
		if (dek !== null) zero(dek);
		// A login with nothing to show for it is revoked, best effort.
		if (loggedIn) await deps.api.logout().catch(() => {});
		throw e;
	} finally {
		zero(kek);
	}
}

/** An archive opened with its recovery key, waiting for a new passphrase. */
export class Recovery {
	#deps: Deps;
	#dek: Bytes | null;
	#authKey: Bytes;
	#manifest: SessionManifest;
	/** The finish under way, which an abandon waits for. */
	#finishing: Promise<unknown> | null = null;

	constructor(deps: Deps, dek: Bytes, authKey: Bytes, manifest: SessionManifest) {
		this.#deps = deps;
		this.#dek = dek;
		this.#authKey = authKey;
		this.#manifest = manifest;
	}

	/**
	 * Sets the passphrase and a fresh recovery key, leaves the session
	 * unlocked and returns the phrase for the new key. The keys held here
	 * are spent either way: on failure the recovery is still open for a
	 * retry, except when the server no longer accepts the login, which the
	 * caller reports and abandons.
	 */
	async finish(newPassphrase: string): Promise<{ recoveryPhrase: string }> {
		normalizePassphrase(newPassphrase);
		if (this.#dek === null) throw new Error('recovery already finished or abandoned');
		const finishing = this.#finish(newPassphrase);
		this.#finishing = finishing;
		try {
			return await finishing;
		} finally {
			this.#finishing = null;
		}
	}

	async #finish(newPassphrase: string): Promise<{ recoveryPhrase: string }> {
		const dek = this.#dek;
		if (dek === null) throw new LockedError();
		const recoveryKey = generateRecoveryKey();
		try {
			const change = { passphrase: newPassphrase, recoveryKey };
			const updated = await callAs(
				rekey(this.#deps, dek, this.#manifest, change, this.#authKey),
				wrong,
				'wrong_credential'
			);
			// An abandon that got past the wait would have zeroed the DEK; a
			// session must never open over zeros.
			if (this.#dek !== dek) throw new LockedError();
			this.#dek = null;
			zero(this.#authKey);
			session.unlock(dek, updated);
			await remember(dek, this.#deps.api);
			return { recoveryPhrase: formatRecoveryKey(recoveryKey) };
		} catch (e) {
			// Another device changed the manifest since it was opened: pick up
			// its version so that the retry is made under the current ETag.
			if (e instanceof ApiError && e.code === 'conflict') await this.#reload(dek);
			throw e;
		} finally {
			zero(recoveryKey);
		}
	}

	/**
	 * Zeroes the keys and revokes the login. A finish under way is waited
	 * for first: its rekey may already have reached the server, and the
	 * session it opens must not be one over zeroed keys. Does nothing after
	 * `finish` succeeded, when the DEK belongs to the session and the login
	 * is its own. The logout is best effort; the server's session expires
	 * on its own.
	 */
	async abandon(): Promise<void> {
		if (this.#finishing !== null) await this.#finishing.catch(() => {});
		if (this.#dek === null) return;
		zero(this.#dek, this.#authKey);
		this.#dek = null;
		try {
			await this.#deps.api.logout();
		} catch {
			// See above.
		}
	}

	async #reload(dek: Bytes): Promise<void> {
		try {
			this.#manifest = openManifest(dek, await requireManifest(this.#deps.api));
		} catch {
			// The retry will report whatever is wrong now.
		}
	}
}
