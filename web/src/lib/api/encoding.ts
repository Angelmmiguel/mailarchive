/**
 * Base64 as Go's `encoding/base64.StdEncoding` speaks it: standard alphabet,
 * padded, and strict on the way in so a malformed value from the server is an
 * error rather than a silently truncated key.
 */
import { base64 } from '@scure/base';
import type { Bytes } from './types';

/** Encodes bytes as padded standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
	return base64.encode(bytes);
}

/** Decodes padded standard base64, throwing on any character or padding error. */
export function decodeBase64(text: string): Bytes {
	return Uint8Array.from(base64.decode(text));
}
