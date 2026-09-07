import { describe, expect, it } from 'vitest';
import { deriveSubkeys, generateDek } from '$lib/crypto/keys';
import { SealError } from '$lib/crypto/aead';
import { encryptBlobAs } from '$lib/crypto/blob';
import { compress } from '$lib/crypto/compress';
import type { IndexRecord } from './records';
import {
	decodeSegmentIndex,
	decodeShard,
	encodeSegmentIndex,
	encodeShard,
	groupShards,
	IndexFormatError,
	shardIdFor
} from './segment';

const keys = deriveSubkeys(generateDek());

const record: IndexRecord = {
	id: 'a'.repeat(64),
	messageId: 'm@x',
	threadId: 'm@x',
	date: '2026-09-06T09:12:32.000Z',
	from: { name: 'A', address: 'a@x' },
	to: [],
	cc: [],
	subject: 'Hello',
	snippet: 'Hello there',
	labels: [],
	size: 10,
	attachments: [],
	view: 'b'.repeat(64)
};

describe('segment index', () => {
	it('round-trips under the blob key, named by content', async () => {
		const { id, sealed } = await encodeSegmentIndex(keys, [record]);

		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(await decodeSegmentIndex(keys, id, sealed)).toEqual([record]);
	});

	it('fails to open under another id or key', async () => {
		const { id, sealed } = await encodeSegmentIndex(keys, [record]);

		await expect(decodeSegmentIndex(keys, 'c'.repeat(64), sealed)).rejects.toThrow(SealError);
		await expect(decodeSegmentIndex(deriveSubkeys(generateDek()), id, sealed)).rejects.toThrow(
			SealError
		);
	});

	it('rejects a shard where an index was expected', async () => {
		const id = shardIdFor(keys, 'seg', 'h');
		const { sealed } = await encodeShard(keys, id, { version: 1, prefix: 'h', terms: {} });

		await expect(decodeSegmentIndex(keys, id, sealed)).rejects.toThrow(IndexFormatError);
	});
});

describe('shards', () => {
	it('rejects postings that are not [id, field, frequency]', async () => {
		const id = 'f'.repeat(64);
		for (const terms of [{ a: 'x' }, { a: [['m', 1]] }, { a: [['m', 1, 0]] }, { a: [[1, 1, 1]] }]) {
			const sealed = encryptBlobAs(
				keys,
				id,
				await compress(new TextEncoder().encode(JSON.stringify({ version: 1, prefix: 'a', terms })))
			);
			await expect(decodeShard(keys, id, sealed)).rejects.toThrow(IndexFormatError);
		}
	});

	it('groups terms by prefix under HMAC names and round-trips', async () => {
		const shards = groupShards('seg', keys, [
			{
				id: 'm1',
				terms: [
					{ term: 'hello', field: 1, frequency: 1 },
					{ term: 'help', field: 4, frequency: 2 },
					{ term: 'world', field: 4, frequency: 1 }
				]
			},
			{ id: 'm2', terms: [{ term: 'hello', field: 4, frequency: 3 }] }
		]);

		expect(shards.size).toBe(2);
		const he = shards.get(shardIdFor(keys, 'seg', 'h'))!;
		expect(he.terms).toEqual({
			hello: [
				['m1', 1, 1],
				['m2', 4, 3]
			],
			help: [['m1', 4, 2]]
		});

		const id = shardIdFor(keys, 'seg', 'h');
		const { sealed } = await encodeShard(keys, id, he);
		expect(await decodeShard(keys, id, sealed)).toEqual(he);
	});

	it('accepts terms that are also Object prototype names', async () => {
		const shards = groupShards('seg', keys, [
			{
				id: 'm1',
				terms: [
					{ term: 'constructor', field: 4, frequency: 1 },
					{ term: '__proto__', field: 4, frequency: 1 },
					{ term: 'hasownproperty', field: 4, frequency: 2 }
				]
			}
		]);

		const [[id, shard]] = [...shards.entries()].filter(([, s]) => s.prefix === 'c');
		expect(shard!.terms.constructor).toEqual([['m1', 4, 1]]);
		const { sealed } = await encodeShard(keys, id!, shard!);
		const back = await decodeShard(keys, id!, sealed);
		expect(back.terms.constructor).toEqual([['m1', 4, 1]]);
		const proto = [...shards.values()].find((s) => s.prefix === '_')!;
		expect(Object.keys(proto.terms)).toEqual(['__proto__']);
	});

	it('names shards differently per segment', () => {
		expect(shardIdFor(keys, 'a', 'h')).not.toBe(shardIdFor(keys, 'b', 'h'));
	});
});
