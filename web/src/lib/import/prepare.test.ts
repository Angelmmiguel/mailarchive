import { describe, expect, it } from 'vitest';
import { decompress } from '$lib/crypto/compress';
import { fixture } from '$lib/mail/message.test';
import { prepare } from './prepare';

describe('prepare', () => {
	it('returns metadata, terms, a compressed view and the compressed original', async () => {
		const bytes = await fixture('report.eml');
		const out = await prepare(bytes);

		expect(out.message.subject).toBe('Your charging summary report is ready');
		expect(out.message).not.toHaveProperty('text');
		expect(out.snippet).toContain('Your charging summary report');
		expect(out.terms.some((t) => t.term === 'charging')).toBe(true);
		expect(await decompress(out.raw)).toEqual(bytes);
		const view = JSON.parse(new TextDecoder().decode(await decompress(out.view)));
		expect(view).toMatchObject({ version: 1, html: expect.stringContaining('charging') });
	});

	it('rejects what is not a message', async () => {
		await expect(prepare(await fixture('broken.eml'))).rejects.toThrow('cannot parse message');
	});
});
