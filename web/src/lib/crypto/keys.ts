/**
 * The DEK and what hangs off it. The DEK is random and protects the whole
 * archive; the subkeys are HKDF outputs, one per purpose, so no two
 * components ever share a key.
 */
import type { Bytes } from '$lib/api/types';
import { open, seal } from './aead';
import { expand } from './kdf';
import { randomBytes, zero } from './random';

export const DEK_LENGTH = 32;

/** The purpose-bound keys derived from the DEK. */
export interface Subkeys {
	/** Encrypts blobs, segment indexes and term shards. */
	blob: Bytes;
	/** HMAC key behind blob and shard ids. */
	id: Bytes;
	/** Encrypts the manifest body. */
	manifest: Bytes;
	/** Encrypts the local IndexedDB cache. */
	cache: Bytes;
}

/** Which key the DEK is wrapped under; each gets its own AAD. */
export type WrapPurpose = 'passphrase' | 'recovery' | 'session';

/** A fresh 32-byte DEK. */
export function generateDek(): Bytes {
	return randomBytes(DEK_LENGTH);
}

/** Derives every subkey from the DEK. Deterministic. */
export function deriveSubkeys(dek: Uint8Array): Subkeys {
	return {
		blob: expand(dek, 'mailarchive/blob/v1'),
		id: expand(dek, 'mailarchive/id/v1'),
		manifest: expand(dek, 'mailarchive/manifest/v1'),
		cache: expand(dek, 'mailarchive/cache/v1')
	};
}

/** Zeroes every subkey; best effort, see `zero`. */
export function zeroSubkeys(keys: Subkeys): void {
	zero(keys.blob, keys.id, keys.manifest, keys.cache);
}

/** Seals the DEK under `kek` for one purpose. */
export function wrapDek(dek: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes {
	return seal(kek, dek, wrapAad(purpose));
}

/** Opens a wrapped DEK; fails with `SealError` under the wrong key or purpose. */
export function unwrapDek(sealed: Uint8Array, kek: Uint8Array, purpose: WrapPurpose): Bytes {
	return open(kek, sealed, wrapAad(purpose));
}

function wrapAad(purpose: WrapPurpose): string {
	return `mailarchive/dek/${purpose}/v1`;
}
