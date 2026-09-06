/**
 * The manifest in two layers: a plaintext header carrying the KDF parameters
 * and the wrapped DEKs, readable before any key is known, and a body sealed
 * under the manifest key. Both directions are strict: anything the server
 * hands back is validated field by field before it is believed.
 */
import { decodeBase64, encodeBase64 } from '$lib/api/encoding';
import type { Bytes } from '$lib/api/types';
import { OVERHEAD, open, seal } from './aead';
import { InvalidKdfParamsError, parseKdfParams, type KdfParams } from './kdf';
import { DEK_LENGTH } from './keys';

/** Manifest schema version this code reads and writes. */
export const MANIFEST_VERSION = 1;
const BODY_AAD = 'mailarchive/manifest/v1';
const WRAPPED_DEK_LENGTH = DEK_LENGTH + OVERHEAD;

/** The part of the manifest that is readable without a key. */
export interface ManifestHeader {
	version: typeof MANIFEST_VERSION;
	kdf: KdfParams;
	/** Sealed DEKs, base64. */
	wrapped: { passphrase: string; recovery: string };
}

/** One import run. Placeholder shape until the import pipeline lands. */
export interface SegmentRef {
	id: string;
	createdAt: string;
	messages: number;
}

/** The part of the manifest sealed under the manifest key. */
export interface ManifestBody {
	settings: { ownAddresses: string[] };
	segments: SegmentRef[];
}

export interface Manifest {
	header: ManifestHeader;
	body: ManifestBody;
}

/** Bytes that are not a manifest this code understands. */
export class ManifestFormatError extends Error {
	constructor(detail: string) {
		super(`malformed manifest: ${detail}`);
		this.name = 'ManifestFormatError';
	}
}

/** Serialises a manifest, sealing the body under `manifestKey`. */
export function encodeManifest(manifest: Manifest, manifestKey: Uint8Array): Bytes {
	const { header, body } = manifest;
	const sealed = seal(manifestKey, new TextEncoder().encode(JSON.stringify(body)), BODY_AAD);
	return new TextEncoder().encode(
		JSON.stringify({
			version: header.version,
			kdf: header.kdf,
			wrapped: header.wrapped,
			body: encodeBase64(sealed)
		})
	);
}

/** Reads and validates the header; needs no key. */
export function decodeManifestHeader(bytes: Uint8Array): ManifestHeader {
	return parseEnvelope(bytes).header;
}

/**
 * Opens and validates the body. A body that fails to authenticate throws
 * `SealError`; one that authenticates but does not have the expected shape
 * throws `ManifestFormatError`.
 */
export function decodeManifestBody(bytes: Uint8Array, manifestKey: Uint8Array): ManifestBody {
	const plaintext = open(manifestKey, parseEnvelope(bytes).sealedBody, BODY_AAD);
	const record = parseJsonObject(plaintext, 'body');
	return { settings: parseSettings(record.settings), segments: parseSegments(record.segments) };
}

function parseEnvelope(bytes: Uint8Array): { header: ManifestHeader; sealedBody: Bytes } {
	const record = parseJsonObject(bytes, 'manifest');
	if (record.version !== MANIFEST_VERSION) {
		throw new ManifestFormatError('unsupported version');
	}
	let kdf: KdfParams;
	try {
		kdf = parseKdfParams(record.kdf);
	} catch (e) {
		if (e instanceof InvalidKdfParamsError) throw new ManifestFormatError(e.message);
		throw e;
	}
	const wrapped = record.wrapped;
	if (wrapped === null || typeof wrapped !== 'object') {
		throw new ManifestFormatError('wrapped is not an object');
	}
	const wrappedRecord: Record<string, unknown> = { ...wrapped };
	return {
		header: {
			version: MANIFEST_VERSION,
			kdf,
			wrapped: {
				passphrase: wrappedDek(wrappedRecord.passphrase, 'wrapped.passphrase'),
				recovery: wrappedDek(wrappedRecord.recovery, 'wrapped.recovery')
			}
		},
		sealedBody: base64Field(record.body, 'body')
	};
}

function wrappedDek(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new ManifestFormatError(`${field} is not a string`);
	if (base64Field(value, field).length !== WRAPPED_DEK_LENGTH) {
		throw new ManifestFormatError(`${field} is not a wrapped key`);
	}
	return value;
}

function base64Field(value: unknown, field: string): Bytes {
	if (typeof value !== 'string') throw new ManifestFormatError(`${field} is not a string`);
	try {
		return decodeBase64(value);
	} catch {
		throw new ManifestFormatError(`${field} is not base64`);
	}
}

function parseJsonObject(bytes: Uint8Array, what: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new ManifestFormatError(`${what} is not JSON`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ManifestFormatError(`${what} is not an object`);
	}
	return { ...parsed };
}

function parseSettings(value: unknown): ManifestBody['settings'] {
	if (value === null || typeof value !== 'object') {
		throw new ManifestFormatError('settings is not an object');
	}
	const record: Record<string, unknown> = { ...value };
	const addresses = record.ownAddresses;
	if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === 'string')) {
		throw new ManifestFormatError('settings.ownAddresses is not a list of strings');
	}
	return { ownAddresses: addresses };
}

function parseSegments(value: unknown): SegmentRef[] {
	if (!Array.isArray(value)) throw new ManifestFormatError('segments is not a list');
	return value.map((entry: unknown, i) => {
		if (entry === null || typeof entry !== 'object') {
			throw new ManifestFormatError(`segments[${i}] is not an object`);
		}
		const { id, createdAt, messages }: Record<string, unknown> = { ...entry };
		if (typeof id !== 'string' || typeof createdAt !== 'string') {
			throw new ManifestFormatError(`segments[${i}] has a malformed id or createdAt`);
		}
		if (typeof messages !== 'number' || !Number.isInteger(messages) || messages < 0) {
			throw new ManifestFormatError(`segments[${i}].messages is not a count`);
		}
		return { id, createdAt, messages };
	});
}
