/**
 * The unlocked archive: the DEK, its subkeys and the decoded manifest, held
 * in memory only. Byte buffers are `$state.raw` because a deep proxy over a
 * Uint8Array would both slow every read and defeat zeroing on lock.
 */
import type { Bytes } from '$lib/api/types';
import { deriveSubkeys, zeroSubkeys, type Subkeys } from '$lib/crypto/keys';
import type { ManifestBody, ManifestHeader } from '$lib/crypto/manifest';
import { zero } from '$lib/crypto/random';

/** The decoded manifest and the ETag guarding its next write. */
export interface SessionManifest {
	header: ManifestHeader;
	body: ManifestBody;
	etag: string;
}

class Session {
	status = $state<'locked' | 'unlocked'>('locked');
	dek = $state.raw<Bytes | null>(null);
	keys = $state.raw<Subkeys | null>(null);
	manifest = $state<SessionManifest | null>(null);

	/** Takes ownership of `dek`, derives the subkeys and opens the session. */
	unlock(dek: Bytes, manifest: SessionManifest): void {
		this.dek = dek;
		this.keys = deriveSubkeys(dek);
		this.manifest = manifest;
		this.status = 'unlocked';
	}

	/** Zeroes every key and forgets the manifest. Safe to call when locked. */
	lock(): void {
		if (this.dek !== null) zero(this.dek);
		if (this.keys !== null) zeroSubkeys(this.keys);
		this.dek = null;
		this.keys = null;
		this.manifest = null;
		this.status = 'locked';
	}
}

export const session = new Session();
