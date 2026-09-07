/**
 * Writing and reading segments. The index is named by its content like any
 * blob; a shard is named by an HMAC of the segment id and its prefix, so
 * the server sees opaque names whose count and size vary per segment.
 * Everything is gzip-compressed before it is sealed.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Bytes } from '$lib/api/types';
import { decryptBlob, encryptBlob, encryptBlobAs } from '$lib/crypto/blob';
import { compress, decompress } from '$lib/crypto/compress';
import type { Subkeys } from '$lib/crypto/keys';
import type { Term } from '$lib/mail/tokenize';
import {
	INDEX_VERSION,
	type IndexRecord,
	type Posting,
	type SegmentIndex,
	type TermShard
} from './records';

/**
 * Characters of a term that pick its shard. One keeps a segment to a few
 * dozen shards (a letter, a digit or another script each) while a prefix
 * search of any length still needs exactly one shard per segment.
 */
export const PREFIX_LENGTH = 1;

/** Bytes that are not an index or shard this code understands. */
export class IndexFormatError extends Error {
	constructor(detail: string) {
		super(`malformed index: ${detail}`);
		this.name = 'IndexFormatError';
	}
}

export interface SealedBlob {
	id: string;
	sealed: Bytes;
}

export async function encodeSegmentIndex(
	keys: Subkeys,
	records: IndexRecord[]
): Promise<SealedBlob> {
	const index: SegmentIndex = { version: INDEX_VERSION, records };
	return encryptBlob(keys, await compress(encodeJson(index)));
}

export async function decodeSegmentIndex(
	keys: Subkeys,
	id: string,
	sealed: Uint8Array
): Promise<IndexRecord[]> {
	const parsed = await openJson(keys, id, sealed);
	if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.records)) {
		throw new IndexFormatError('not a segment index');
	}
	return parsed.records as IndexRecord[];
}

/** The terms of every message of a segment, grouped into shards by prefix. */
export function groupShards(
	segmentId: string,
	keys: Subkeys,
	terms: Iterable<{ id: string; terms: Term[] }>
): Map<string, TermShard> {
	const shards = new Map<string, TermShard>();
	for (const message of terms) {
		for (const { term, field, frequency } of message.terms) {
			const prefix = Array.from(term).slice(0, PREFIX_LENGTH).join('');
			const shardId = shardIdFor(keys, segmentId, prefix);
			let shard = shards.get(shardId);
			if (shard === undefined) {
				// No prototype: "constructor" is a perfectly good search term.
				shard = {
					version: INDEX_VERSION,
					prefix,
					terms: Object.create(null) as TermShard['terms']
				};
				shards.set(shardId, shard);
			}
			const posting: Posting = [message.id, field, frequency];
			(shard.terms[term] ??= []).push(posting);
		}
	}
	return shards;
}

export async function encodeShard(
	keys: Subkeys,
	id: string,
	shard: TermShard
): Promise<SealedBlob> {
	return { id, sealed: encryptBlobAs(keys, id, await compress(encodeJson(shard))) };
}

export async function decodeShard(
	keys: Subkeys,
	id: string,
	sealed: Uint8Array
): Promise<TermShard> {
	const parsed = await openJson(keys, id, sealed);
	if (
		parsed.version !== INDEX_VERSION ||
		typeof parsed.terms !== 'object' ||
		parsed.terms === null
	) {
		throw new IndexFormatError('not a term shard');
	}
	return parsed as unknown as TermShard;
}

/** `HMAC-SHA256(id key, "<segment id>/<prefix>")`, hex. */
export function shardIdFor(keys: Subkeys, segmentId: string, prefix: string): string {
	return bytesToHex(hmac(sha256, keys.id, new TextEncoder().encode(`${segmentId}/${prefix}`)));
}

function encodeJson(value: unknown): Bytes {
	return new TextEncoder().encode(JSON.stringify(value));
}

async function openJson(
	keys: Subkeys,
	id: string,
	sealed: Uint8Array
): Promise<Record<string, unknown>> {
	const plaintext = await decompress(decryptBlob(keys, id, sealed));
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
	} catch {
		throw new IndexFormatError('not JSON');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new IndexFormatError('not an object');
	}
	return { ...parsed };
}
