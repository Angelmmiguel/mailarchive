/**
 * Recovery: the doc's Recover flow, which ends in a Rekey. The phrase logs
 * in and opens the DEK; the account then gets a new passphrase and a new
 * recovery key, so the phrase that was just typed stops working.
 */
import { decodeBase64 } from '$lib/api/encoding';
import type { Bytes } from '$lib/api/types';
import { expandRoot, normalizePassphrase } from '$lib/crypto/kdf';
import { unwrapDek } from '$lib/crypto/keys';
import { decodeManifestHeader } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from '$lib/crypto/recovery';
import { session, type SessionManifest } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { callAs, WrongRecoveryKeyError } from './errors';
import { rekey } from './rotate';
import { openManifest, remember, requireManifest } from './unlock';

/**
 * Regains access with the recovery phrase and sets a new passphrase. Leaves
 * the session unlocked and returns the phrase for the fresh recovery key.
 *
 * The recovery auth key is the current credential the rekey has to present,
 * so it lives until the server has answered; the recovery KEK is done as
 * soon as the DEK is open.
 */
export async function recover(
	phrase: string,
	newPassphrase: string,
	deps: Deps = defaultDeps
): Promise<{ recoveryPhrase: string }> {
	normalizePassphrase(newPassphrase);
	const recoveryKey = parseRecoveryKey(phrase);
	const { kek, authKey } = expandRoot(recoveryKey);
	zero(recoveryKey);
	const wrong = () => new WrongRecoveryKeyError();

	try {
		let dek: Bytes;
		let current: SessionManifest;
		try {
			await callAs(deps.api.login(authKey), wrong, 'unauthorized');
			const manifest = await requireManifest(deps.api);
			const header = decodeManifestHeader(manifest.data);
			dek = unwrapDek(decodeBase64(header.wrapped.recovery), kek, 'recovery');
			current = openManifest(dek, manifest);
		} finally {
			zero(kek);
		}

		const newRecoveryKey = generateRecoveryKey();
		try {
			const change = { passphrase: newPassphrase, recoveryKey: newRecoveryKey };
			const updated = await callAs(
				rekey(deps, dek, current, change, authKey),
				wrong,
				'wrong_credential'
			);
			session.unlock(dek, updated);
			await remember(dek, deps.api);
			return { recoveryPhrase: formatRecoveryKey(newRecoveryKey) };
		} catch (e) {
			zero(dek);
			throw e;
		} finally {
			zero(newRecoveryKey);
		}
	} finally {
		zero(authKey);
	}
}
