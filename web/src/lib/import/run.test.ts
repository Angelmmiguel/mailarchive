import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import { blobId, decryptBlob } from '$lib/crypto/blob';
import { decompress } from '$lib/crypto/compress';
import { deriveSubkeys } from '$lib/crypto/keys';
import { decodeSegmentIndex, decodeShard } from '$lib/index/segment';
import { fixture } from '$lib/mail/message.test';
import { importState } from '$lib/state/import.svelte';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { terms } from '$lib/state/terms.svelte';
import { MemoryCache } from '$lib/cache/blobs';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { inlineParser, ParserClosedError } from './parser';
import { MAX_FILE_BYTES, runImport, SEGMENT_MESSAGES } from './run';
import type { ImportFile } from './sources';

let api: MockApi;
let account: TestAccount;
let stored: Map<string, Uint8Array>;
let cache: MemoryCache;

async function files(...names: string[]): Promise<ImportFile[]> {
	return Promise.all(
		names.map(async (name) => ({
			path: name,
			file: new File([(await fixture(name)) as Uint8Array<ArrayBuffer>], name)
		}))
	);
}

function run(list: ImportFile[], signal = new AbortController().signal) {
	return runImport(list, 'test', { api, cache, parser: inlineParser(), signal });
}

beforeEach(() => {
	session.lock();
	index.clear();
	terms.clear();
	importState.reset();
	cache = new MemoryCache();
	api = mockApi();
	account = createTestAccount();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: { settings: { ownAddresses: ['reader@example.org'] }, segments: [] },
		etag: '"v1"'
	});
	stored = new Map();
	api.putBlob.mockImplementation((id, data) => {
		if (stored.has(id)) return Promise.resolve('exists');
		stored.set(id, data);
		return Promise.resolve('created');
	});
	api.putManifest.mockResolvedValue({ etag: '"v2"' });
});

describe('runImport', () => {
	it('uploads raw and view blobs, writes the segment and reports the counts', async () => {
		const summary = await run(
			await files('newsletter.eml', 'report.eml', 'reply.eml', 'broken.eml')
		);

		expect(summary).toMatchObject({ added: 3, duplicates: 0, failed: 1, cancelled: false });
		expect(importState.status).toBe('done');
		expect(importState.counts).toEqual({
			total: 4,
			processed: 4,
			parsed: 3,
			uploaded: 3,
			duplicates: 0,
			failed: 1
		});
		expect(importState.failures).toEqual([{ path: 'broken.eml', reason: expect.any(String) }]);

		const keys = deriveSubkeys(account.dek);
		const segment = summary.segments[0]!;
		const records = await decodeSegmentIndex(keys, segment.id, stored.get(segment.id)!);
		expect(records.map((r) => r.subject)).toEqual(
			expect.arrayContaining([
				'Tablón de Gómez Project 🇨🇴',
				'Your charging summary report is ready',
				'Re: Your charging summary report is ready'
			])
		);
		const reply = records.find((r) => r.messageId === 'reply-1@example.org')!;
		const report = records.find((r) => r.subject === 'Your charging summary report is ready')!;
		expect(reply.threadId).toBe(report.threadId);
		expect(reply.labels).toEqual(['sent']);
		expect(report.labels).toEqual(['attachments']);
		expect(report.attachments.map((a) => a.name)).toEqual([
			'logo.png',
			'charging-summary-august.pdf'
		]);

		// The raw blob opens back into the original bytes; the view into JSON.
		const raw = await decompress(decryptBlob(keys, report.id, stored.get(report.id)!));
		expect(raw).toEqual(await fixture('report.eml'));
		const view = JSON.parse(
			new TextDecoder().decode(
				await decompress(decryptBlob(keys, report.view, stored.get(report.view)!))
			)
		);
		expect(view.html).toContain('charging summary');

		// Every shard is stored and decodes; the index knows the messages now.
		expect(segment.shards.length).toBeGreaterThan(3);
		for (const id of segment.shards) {
			await expect(decodeShard(keys, id, stored.get(id)!)).resolves.toBeTruthy();
		}
		expect(session.manifest?.body.segments).toEqual([segment]);
		expect(index.messages).toBe(3);

		// The shards are searchable at once and cached with the index for the next unlock.
		expect(terms.segments).toEqual(new Set([segment.id]));
		expect(terms.index.lookup('charging').length).toBeGreaterThan(0);
		expect([...cache.entries.keys()].sort()).toEqual([segment.id, ...segment.shards].sort());
	});

	it('skips messages the archive holds, by bytes or by headers', async () => {
		await run(await files('report.eml'));
		api.putBlob.mockClear();

		const summary = await run(await files('report.eml', 'report-reexport.eml'));

		expect(summary).toMatchObject({ added: 0, duplicates: 2, failed: 0, segments: [] });
		expect(api.putBlob).not.toHaveBeenCalled();
		expect(importState.counts.parsed).toBe(1);
	});

	it('skips a second copy within the same run, by bytes or by headers', async () => {
		const summary = await run(await files('report.eml', 'report.eml', 'report-reexport.eml'));

		expect(summary).toMatchObject({ added: 1, duplicates: 2 });
	});

	it('commits what finished when cancelled', async () => {
		// The first upload cancels the run: the message it belongs to completes,
		// the ones still being parsed never reach the server.
		const controller = new AbortController();
		api.putBlob.mockImplementation((id, data) => {
			stored.set(id, data);
			controller.abort();
			return Promise.resolve('created');
		});

		const summary = await run(
			await files('newsletter.eml', 'report.eml', 'reply.eml'),
			controller.signal
		);

		expect(summary.cancelled).toBe(true);
		expect(summary.added).toBe(1);
		expect(importState.counts.parsed).toBe(3);
		expect(importState.status).toBe('cancelled');
		expect(session.manifest?.body.segments).toHaveLength(1);
	});

	it('stops on a server failure, keeps what was uploaded and reports it', async () => {
		const failing = blobId(deriveSubkeys(account.dek).id, await fixture('reply.eml'));
		api.putBlob.mockImplementation((id, data) => {
			if (id === failing) return Promise.reject(new ApiError(500, 'internal'));
			stored.set(id, data);
			return Promise.resolve('created');
		});

		await expect(run(await files('newsletter.eml', 'report.eml', 'reply.eml'))).rejects.toThrow(
			ApiError
		);
		expect(importState.status).toBe('done');
		expect(importState.error).toContain('500');
		expect(session.manifest?.body.segments).toHaveLength(1);
		expect(index.messages).toBe(2);
	});
	it('refuses a file above the size gate and a body the server calls too large, per file', async () => {
		const big = { path: 'big.eml', file: { size: MAX_FILE_BYTES + 1 } as File };
		const [report] = await files('report.eml');
		api.putBlob.mockImplementation(() => Promise.reject(new ApiError(413, 'too_large')));

		const summary = await run([big, report!]);

		expect(summary).toMatchObject({ added: 0, failed: 2, segments: [] });
		expect(importState.failures.map((f) => f.reason)).toEqual([
			'larger than 48 MiB',
			'too large for the server'
		]);
	});

	it('writes several segments when a run exceeds the batch size', async () => {
		const [report, reply, newsletter] = await files('report.eml', 'reply.eml', 'newsletter.eml');
		const many = Array.from({ length: SEGMENT_MESSAGES + 2 }, (_, i) => {
			// Distinct bytes and Message-IDs, otherwise they would be duplicates.
			const text = `From: a@x\r\nTo: b@x\r\nSubject: ${i}\r\nMessage-ID: <m${i}@x>\r\nDate: Wed, 02 Sep 2026 07:21:48 +0000\r\n\r\nbody ${i}\r\n`;
			return { path: `${i}.eml`, file: new File([text], `${i}.eml`) };
		});

		const summary = await run([report!, reply!, newsletter!, ...many]);

		expect(summary.segments.map((s) => s.messages)).toEqual([SEGMENT_MESSAGES, 5]);
		expect(summary.added).toBe(SEGMENT_MESSAGES + 5);
		expect(index.messages).toBe(SEGMENT_MESSAGES + 5);
		expect(session.manifest?.body.segments).toHaveLength(2);
	}, 60_000);

	it('is a per-file failure when the parser gives up, and a quiet stop when cancelled', async () => {
		const controller = new AbortController();
		const parser = {
			prepare: () => Promise.reject(new ParserClosedError('import cancelled')),
			close: () => {}
		};
		const list = await files('report.eml', 'reply.eml');

		const failed = await runImport(list, 'x', { api, parser, signal: controller.signal });
		expect(failed).toMatchObject({ failed: 2, added: 0 });

		importState.reset();
		controller.abort();
		const stopped = await runImport(list, 'x', { api, parser, signal: controller.signal });
		expect(stopped).toMatchObject({ failed: 0, added: 0, cancelled: true });
	});
});
