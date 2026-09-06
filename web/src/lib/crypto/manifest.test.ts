import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '$lib/api/encoding';
import { seal, SealError } from './aead';
import { newKdfParams } from './kdf';
import { deriveSubkeys, generateDek, unwrapDek, wrapDek } from './keys';
import {
	decodeManifestBody,
	decodeManifestHeader,
	encodeManifest,
	ManifestFormatError,
	type Manifest
} from './manifest';

const dek = generateDek();
const keys = deriveSubkeys(dek);
const kek = new Uint8Array(32).map((_, i) => i);
const recoveryKek = new Uint8Array(32).map((_, i) => 255 - i);

const manifest: Manifest = {
	header: {
		version: 1,
		kdf: newKdfParams(),
		wrapped: {
			passphrase: encodeBase64(wrapDek(dek, kek, 'passphrase')),
			recovery: encodeBase64(wrapDek(dek, recoveryKek, 'recovery'))
		}
	},
	body: {
		settings: { ownAddresses: ['me@example.com', 'me@example.org'] },
		segments: [{ id: 'a'.repeat(64), createdAt: '2026-09-06T10:00:00Z', messages: 12 }]
	}
};

function json(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

/** The encoded manifest as a JSON object, for tests that tamper with a field. */
function envelope(): Record<string, unknown> {
	const parsed: unknown = JSON.parse(
		new TextDecoder().decode(encodeManifest(manifest, keys.manifest))
	);
	if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
	return { ...parsed };
}

describe('encodeManifest', () => {
	it('round-trips both layers', () => {
		const bytes = encodeManifest(manifest, keys.manifest);

		expect(decodeManifestHeader(bytes)).toEqual(manifest.header);
		expect(decodeManifestBody(bytes, keys.manifest)).toEqual(manifest.body);
	});

	it('writes the documented layout, with the body sealed', () => {
		const record = envelope();

		expect(Object.keys(record).sort()).toEqual(['body', 'kdf', 'version', 'wrapped']);
		expect(record.version).toBe(1);
		expect(record.kdf).toEqual(manifest.header.kdf);
		expect(record.wrapped).toEqual(manifest.header.wrapped);
		const text = new TextDecoder().decode(encodeManifest(manifest, keys.manifest));
		expect(text).not.toContain('me@example.com');
		expect(text).not.toContain('segments');
	});
});

describe('decodeManifestHeader', () => {
	it('reads the wrapped keys without any key', () => {
		const header = decodeManifestHeader(encodeManifest(manifest, keys.manifest));

		expect(unwrapDek(decodeBase64(header.wrapped.passphrase), kek, 'passphrase')).toEqual(dek);
		expect(unwrapDek(decodeBase64(header.wrapped.recovery), recoveryKek, 'recovery')).toEqual(dek);
	});

	it.each([
		['not JSON', new TextEncoder().encode('{"version":')],
		['invalid UTF-8', new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])],
		['a JSON array', json([envelope()])],
		['a JSON string', json('manifest')],
		['a missing version', json({ ...envelope(), version: undefined })],
		['an unknown version', json({ ...envelope(), version: 2 })],
		['a string version', json({ ...envelope(), version: '1' })],
		['a missing kdf', json({ ...envelope(), kdf: undefined })],
		['a hostile kdf', json({ ...envelope(), kdf: { ...manifest.header.kdf, m: 1 } })],
		['a missing wrapped', json({ ...envelope(), wrapped: undefined })],
		['wrapped as a string', json({ ...envelope(), wrapped: 'x' })],
		['a missing passphrase wrap', json({ ...envelope(), wrapped: { recovery: 'AA==' } })],
		[
			'a passphrase wrap that is not base64',
			json({ ...envelope(), wrapped: { ...manifest.header.wrapped, passphrase: '!!' } })
		],
		[
			'a recovery wrap of the wrong length',
			json({ ...envelope(), wrapped: { ...manifest.header.wrapped, recovery: 'AAAA' } })
		],
		[
			'a numeric recovery wrap',
			json({ ...envelope(), wrapped: { ...manifest.header.wrapped, recovery: 5 } })
		],
		['a missing body', json({ ...envelope(), body: undefined })],
		['a body that is not base64', json({ ...envelope(), body: 'not base64!' })]
	])('rejects %s', (_, bytes) => {
		expect(() => decodeManifestHeader(bytes)).toThrow(ManifestFormatError);
	});
});

describe('decodeManifestBody', () => {
	it('fails to open a tampered body', () => {
		const record = envelope();
		const sealed = decodeBase64(String(record.body));
		sealed[sealed.length - 1] ^= 0x01;

		expect(() =>
			decodeManifestBody(json({ ...record, body: encodeBase64(sealed) }), keys.manifest)
		).toThrow(SealError);
	});

	it('fails to open under another key', () => {
		expect(() => decodeManifestBody(encodeManifest(manifest, keys.manifest), keys.blob)).toThrow(
			SealError
		);
	});

	it('fails on a malformed envelope before touching the key', () => {
		expect(() => decodeManifestBody(json({ ...envelope(), version: 3 }), keys.manifest)).toThrow(
			ManifestFormatError
		);
	});

	it.each([
		['a body that is not an object', []],
		['missing settings', { segments: [] }],
		['settings without addresses', { settings: {}, segments: [] }],
		['addresses that are not strings', { settings: { ownAddresses: [1] }, segments: [] }],
		['addresses as a string', { settings: { ownAddresses: 'me@example.com' }, segments: [] }],
		['missing segments', { settings: { ownAddresses: [] } }],
		['segments as an object', { settings: { ownAddresses: [] }, segments: {} }],
		['a segment that is a string', { settings: { ownAddresses: [] }, segments: ['x'] }],
		[
			'a segment without an id',
			{ settings: { ownAddresses: [] }, segments: [{ createdAt: 'now', messages: 1 }] }
		],
		[
			'a segment with a negative count',
			{ settings: { ownAddresses: [] }, segments: [{ id: 'x', createdAt: 'now', messages: -1 }] }
		],
		[
			'a segment with a fractional count',
			{ settings: { ownAddresses: [] }, segments: [{ id: 'x', createdAt: 'now', messages: 1.5 }] }
		]
	])('rejects a sealed body with %s', (_, body) => {
		// A body sealed under the right key authenticates fine, so only the
		// shape check can reject it.
		expect(() => decodeManifestBody(withBody(body), keys.manifest)).toThrow(ManifestFormatError);
	});

	it('keeps only the known fields of the body', () => {
		const bytes = withBody({ ...manifest.body, extra: true });

		expect(decodeManifestBody(bytes, keys.manifest)).toEqual(manifest.body);
	});
});

/** A genuine envelope whose body is `value` sealed under the manifest key. */
function withBody(value: unknown): Uint8Array {
	const sealed = seal(keys.manifest, json(value), 'mailarchive/manifest/v1');
	return json({ ...envelope(), body: encodeBase64(sealed) });
}

describe('withBody', () => {
	it('reproduces a genuine manifest', () => {
		expect(decodeManifestBody(withBody(manifest.body), keys.manifest)).toEqual(manifest.body);
	});
});
