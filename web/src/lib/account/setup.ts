/**
 * Creating the account: the doc's Setup flow.
 */
import { encodeBase64 } from '$lib/api/encoding';
import { expandRoot, normalizePassphrase } from '$lib/crypto/kdf';
import { deriveSubkeys, generateDek, wrapDek, zeroSubkeys } from '$lib/crypto/keys';
import { encodeManifest, MANIFEST_VERSION, type ManifestHeader } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';
import { formatRecoveryKey, generateRecoveryKey } from '$lib/crypto/recovery';
import { session } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, SetupUnfinishedError } from './errors';
import { openManifest, remember, requireManifest } from './unlock';

/**
 * Generates every key, registers with the server in one request that carries
 * both credentials and the first manifest, logs in and leaves the session
 * unlocked. The returned phrase is the only copy of the recovery key; it
 * must be shown to the user.
 *
 * The manifest the session opens is the one the server hands back after
 * login, not the local copy: that is where its ETag comes from, and opening
 * it under the DEK proves the server stored what was sent.
 *
 * Setup is atomic on the server. A failure after it is therefore not a
 * half-made account but one that exists and cannot be shown its recovery
 * phrase, which `SetupUnfinishedError` reports with the failure as cause.
 */
export async function createAccount(
	passphrase: string,
	ownAddresses: string[] = [],
	deps: Deps = defaultDeps
): Promise<{ recoveryPhrase: string }> {
	normalizePassphrase(passphrase);
	const dek = generateDek();
	const recoveryKey = generateRecoveryKey();
	const kdf = deps.newKdfParams();

	const root = await deps.deriveRoot(passphrase, kdf);
	const { kek, authKey } = expandRoot(root);
	zero(root);
	const { kek: recoveryKek, authKey: recoveryAuthKey } = expandRoot(recoveryKey);
	const header: ManifestHeader = {
		version: MANIFEST_VERSION,
		kdf,
		wrapped: {
			passphrase: encodeBase64(wrapDek(dek, kek, 'passphrase')),
			recovery: encodeBase64(wrapDek(dek, recoveryKek, 'recovery'))
		}
	};
	zero(kek, recoveryKek);
	const keys = deriveSubkeys(dek);
	const manifest = encodeManifest(
		{ header, body: { settings: { ownAddresses }, segments: [] } },
		keys.manifest
	);
	zeroSubkeys(keys);

	let created = false;
	try {
		await call(deps.api.setup({ authKey, recoveryAuthKey, kdf, manifest }));
		created = true;
		await call(deps.api.login(authKey));
		session.unlock(dek, openManifest(dek, await requireManifest(deps.api)));
	} catch (e) {
		zero(dek, recoveryKey);
		throw created ? new SetupUnfinishedError(e) : e;
	} finally {
		zero(authKey, recoveryAuthKey);
	}

	await remember(dek, deps.api);
	const recoveryPhrase = formatRecoveryKey(recoveryKey);
	zero(recoveryKey);
	return { recoveryPhrase };
}
