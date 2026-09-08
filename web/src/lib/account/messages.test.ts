import { beforeEach, describe, expect, it } from 'vitest';
import { compress } from '$lib/crypto/compress';
import { encryptBlob, encryptBlobAs } from '$lib/crypto/blob';
import { deriveSubkeys } from '$lib/crypto/keys';
import { prepare } from '$lib/import/prepare';
import { fixture } from '$lib/mail/message.test';
import { session } from '$lib/state/session.svelte';
import { createTestAccount, mockApi, type MockApi, type TestAccount } from '$lib/testing/account';
import { LockedError } from './errors';
import {
	forgetMessages,
	MessageFormatError,
	MissingBlobError,
	openAttachment,
	openInlineImages,
	openMessage,
	openOriginal
} from './messages';

let api: MockApi;
let account: TestAccount;

async function stored(name: string): Promise<{ id: string; view: string; bytes: Uint8Array }> {
	const bytes = await fixture(name);
	const keys = deriveSubkeys(account.dek);
	const prepared = await prepare(bytes);
	const view = encryptBlob(keys, prepared.view);
	const id = 'a'.repeat(64);
	const raw = encryptBlobAs(keys, id, prepared.raw);
	api.getBlob.mockImplementation((wanted) =>
		Promise.resolve(wanted === id ? raw : wanted === view.id ? view.sealed : null)
	);
	return { id, view: view.id, bytes };
}

beforeEach(() => {
	session.lock();
	forgetMessages();
	api = mockApi();
	account = createTestAccount();
	session.unlock(Uint8Array.from(account.dek), {
		header: account.header,
		body: account.body,
		etag: '"v1"'
	});
});

describe('openMessage', () => {
	it('fetches, opens and caches the view', async () => {
		const { view } = await stored('report.eml');

		const message = await openMessage({ view }, { api });
		expect(message.subject).toBe('Your charging summary report is ready');
		expect(message.html).toContain('<');
		expect(message.attachments.map((a) => a.name)).toContain('charging-summary-august.pdf');

		await openMessage({ view }, { api });
		expect(api.getBlob).toHaveBeenCalledTimes(1);
	});

	it('reports a blob the server lost, and tries again next time', async () => {
		api.getBlob.mockResolvedValue(null);

		await expect(openMessage({ view: 'b'.repeat(64) }, { api })).rejects.toThrow(MissingBlobError);
		await expect(openMessage({ view: 'b'.repeat(64) }, { api })).rejects.toThrow(MissingBlobError);
		expect(api.getBlob).toHaveBeenCalledTimes(2);
	});

	it('rejects a blob that is not a view', async () => {
		const keys = deriveSubkeys(account.dek);
		const blob = encryptBlob(keys, await compress(new TextEncoder().encode('{"version":2}')));
		api.getBlob.mockResolvedValue(blob.sealed);

		await expect(openMessage({ view: blob.id }, { api })).rejects.toThrow(MessageFormatError);
	});

	it('refuses while locked', async () => {
		session.lock();

		await expect(openMessage({ view: 'b'.repeat(64) }, { api })).rejects.toThrow(LockedError);
	});
});

describe('openOriginal and openAttachment', () => {
	it('returns the original bytes and extracts a part from them', async () => {
		const { id, bytes } = await stored('report.eml');

		expect(await openOriginal({ id }, { api })).toEqual(bytes);

		const file = await openAttachment(
			{ id },
			{
				name: 'charging-summary-august.pdf',
				type: 'application/pdf',
				size: 0,
				inline: false,
				index: 1
			},
			{ api }
		);
		expect(file.name).toBe('charging-summary-august.pdf');
		expect(new TextDecoder().decode(file.bytes.slice(0, 5))).toBe('%PDF-');
	});

	it('collects the images an HTML body embeds by content id', async () => {
		const { id } = await stored('report.eml');

		const images = await openInlineImages({ id }, { api });
		expect([...images.keys()]).toEqual(['logo@fixture']);
		expect(images.get('logo@fixture')?.type).toBe('image/png');
		expect(images.get('logo@fixture')?.bytes.length).toBeGreaterThan(0);
	});

	it('rejects a part index the message does not have', async () => {
		const { id } = await stored('report.eml');

		await expect(
			openAttachment({ id }, { name: 'x', type: 'x', size: 0, inline: false, index: 9 }, { api })
		).rejects.toThrow(MessageFormatError);
	});
});

describe('openMessage across a lock', () => {
	it('keeps nothing opened during a lock', async () => {
		const { view } = await stored('report.eml');
		const original = api.getBlob.getMockImplementation()!;
		api.getBlob.mockImplementation((wanted) => {
			const result = original(wanted);
			session.lock();
			return result;
		});

		await expect(openMessage({ view }, { api })).rejects.toThrow(LockedError);
	});
});
