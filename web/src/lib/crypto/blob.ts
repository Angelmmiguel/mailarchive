/**
 * Blob naming and sealing. The id is a keyed hash of the plaintext, so equal
 * messages deduplicate while the server, lacking the id key, cannot relate an
 * id to anything. The id doubles as AAD, so a blob served under another id
 * fails to open.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Bytes } from '$lib/api/types';
import { open, seal } from './aead';
import type { Subkeys } from './keys';

/** `HMAC-SHA256(idKey, SHA-256(plaintext))` as 64 lowercase hex characters. */
export function blobId(idKey: Uint8Array, plaintext: Uint8Array): string {
	return bytesToHex(hmac(sha256, idKey, sha256(plaintext)));
}

/** Names and seals a blob for upload. */
export function encryptBlob(keys: Subkeys, plaintext: Uint8Array): { id: string; sealed: Bytes } {
	const id = blobId(keys.id, plaintext);
	return { id, sealed: seal(keys.blob, plaintext, id) };
}

/**
 * Seals a blob under a name chosen by the caller: a raw message named by
 * its original bytes though the sealed content is compressed, or a term
 * shard named by its prefix.
 */
export function encryptBlobAs(keys: Subkeys, id: string, plaintext: Uint8Array): Bytes {
	return seal(keys.blob, plaintext, id);
}

/** Opens a blob fetched under `id`. */
export function decryptBlob(keys: Subkeys, id: string, sealed: Uint8Array): Bytes {
	return open(keys.blob, sealed, id);
}
