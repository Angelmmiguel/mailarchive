/**
 * Editing the manifest body while unlocked. The header is kept as it is;
 * the body is re-sealed and sent under the manifest's ETag, so a write from
 * another device is never silently overwritten.
 */
import type { ManifestBody } from '$lib/crypto/manifest';
import { encodeManifest } from '$lib/crypto/manifest';
import { session, type SessionManifest } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';

/** Replaces the settings of the unlocked archive and stores the manifest. */
export async function saveSettings(
	settings: ManifestBody['settings'],
	deps: Deps = defaultDeps
): Promise<void> {
	if (session.status !== 'unlocked' || session.keys === null || session.manifest === null) {
		throw new LockedError();
	}
	const current: SessionManifest = session.manifest;
	const body: ManifestBody = { ...current.body, settings };
	const data = encodeManifest({ header: current.header, body }, session.keys.manifest);
	const { etag } = await call(deps.api.putManifest(data, current.etag));
	session.manifest = { header: current.header, body, etag };
}
