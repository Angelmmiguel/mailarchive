import { beforeEach, describe, expect, it } from 'vitest';
import type { Bytes } from '$lib/api/types';
import { encryptBlobAs } from '$lib/crypto/blob';
import { deriveSubkeys } from '$lib/crypto/keys';
import { prepare } from '$lib/import/prepare';
import type { IndexRecord } from '$lib/index/records';
import { fixture } from '$lib/mail/message.test';
import { exportState } from '$lib/state/export.svelte';
import { index } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import { exportArchive, fileName, yearOf, type ExportFolder } from './export';

let api: MockApi;
let account: TestAccount;

/** A folder kept in memory: `files` maps `year/name` to the bytes written. */
function memoryFolder(files: Map<string, Bytes>, path = ''): ExportFolder {
	return {
		getDirectoryHandle: (name) => Promise.resolve(memoryFolder(files, `${path}${name}/`)),
		getFileHandle: (name) =>
			Promise.resolve({
				createWritable: () => {
					let held: Bytes = new Uint8Array();
					return Promise.resolve({
						write: (data: FileSystemWriteChunkType) => {
							held = data as Bytes;
							return Promise.resolve();
						},
						close: () => {
							files.set(`${path}${name}`, held);
							return Promise.resolve();
						}
					});
				}
			})
	};
}

const record = (over: Partial<IndexRecord> & Pick<IndexRecord, 'id'>): IndexRecord => ({
	messageId: null,
	threadId: over.id,
	date: '2026-09-02T07:05:00.000Z',
	from: null,
	to: [],
	cc: [],
	subject: 'Re: Señal',
	snippet: '',
	size: 1,
	attachments: [],
	view: 'v'.repeat(64),
	...over
});

const blobs = new Map<string, Bytes>();

async function stored(id: string, name: string): Promise<Uint8Array> {
	const bytes = await fixture(name);
	const prepared = await prepare(bytes);
	blobs.set(id, encryptBlobAs(deriveSubkeys(account.dek), id, prepared.raw));
	return bytes;
}

beforeEach(() => {
	session.lock();
	index.clear();
	blobs.clear();
	api = mockApi();
	api.getBlob.mockImplementation((id) => Promise.resolve(blobs.get(id) ?? null));
	account = createTestAccount();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: account.body,
		etag: '"v1"'
	});
});

describe('exportArchive', () => {
	it('writes every message as it was imported, a year per folder', async () => {
		const a = 'a'.repeat(64);
		const b = 'b'.repeat(64);
		const reply = await stored(a, 'reply.eml');
		const report = await stored(b, 'report.eml');
		index.add('s1', [
			record({ id: a }),
			record({ id: b, date: '2025-12-31T23:59:00.000Z', subject: 'Report: ready?' })
		]);
		const files = new Map<string, Bytes>();

		const summary = await exportArchive(memoryFolder(files), {
			api,
			signal: new AbortController().signal
		});

		expect(summary).toEqual({ written: 2, failed: 0, cancelled: false });
		expect([...files.keys()].sort()).toEqual([
			`2025/2025-12-31_Report_ready_${'b'.repeat(12)}.eml`,
			`2026/2026-09-02_Re_Señal_${'a'.repeat(12)}.eml`
		]);
		expect(files.get(`2026/2026-09-02_Re_Señal_${'a'.repeat(12)}.eml`)).toEqual(reply);
		expect(files.get(`2025/2025-12-31_Report_ready_${'b'.repeat(12)}.eml`)).toEqual(report);
		expect(exportState.status).toBe('done');
		expect(exportState.done).toBe(2);
	});

	it('skips a message whose blob is gone and says so', async () => {
		const a = 'a'.repeat(64);
		await stored(a, 'reply.eml');
		index.add('s1', [record({ id: a }), record({ id: 'c'.repeat(64), date: null })]);
		const files = new Map<string, Bytes>();

		const summary = await exportArchive(memoryFolder(files), {
			api,
			signal: new AbortController().signal
		});

		expect(summary).toEqual({ written: 1, failed: 1, cancelled: false });
		expect(files.size).toBe(1);
		expect(exportState.failed).toBe(1);
	});

	it('stops where it is when cancelled', async () => {
		const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(64));
		for (const id of ids) await stored(id, 'reply.eml');
		index.add(
			's1',
			ids.map((id) => record({ id }))
		);
		const files = new Map<string, Bytes>();
		const controller = new AbortController();
		api.getBlob.mockImplementation((id) => {
			controller.abort();
			return Promise.resolve(blobs.get(id) ?? null);
		});

		const summary = await exportArchive(memoryFolder(files), {
			api,
			signal: controller.signal
		});

		expect(summary.cancelled).toBe(true);
		expect(summary.written).toBeLessThan(ids.length);
		expect(exportState.status).toBe('cancelled');
	});

	it('gives up when the archive is locked meanwhile', async () => {
		const a = 'a'.repeat(64);
		await stored(a, 'reply.eml');
		index.add('s1', [record({ id: a }), record({ id: 'b'.repeat(64) })]);
		api.getBlob.mockImplementation((id) => {
			session.lock();
			return Promise.resolve(blobs.get(id) ?? null);
		});

		await expect(
			exportArchive(memoryFolder(new Map()), { api, signal: new AbortController().signal })
		).rejects.toThrow(LockedError);
		expect(exportState.status).toBe('cancelled');
	});
});

describe('fileName', () => {
	it('is the day, the subject made safe, and a piece of the id', () => {
		expect(
			fileName({ id: 'f'.repeat(64), date: '2021-09-30T08:19:12.000Z', subject: 'a/b: c?' })
		).toBe('2021-09-30_a_b_c_ffffffffffff.eml');
		expect(fileName({ id: 'f'.repeat(64), date: null, subject: '  ' })).toBe(
			'undated_no_subject_ffffffffffff.eml'
		);
		expect(yearOf({ date: null })).toBe('undated');
		expect(yearOf({ date: '1999-01-01T00:00:00.000Z' })).toBe('1999');
	});
});
