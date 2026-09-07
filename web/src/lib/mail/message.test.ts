import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MessageParseError, parseMessage, snippetOf } from './message';

export const FIXTURES = new URL('../../../tests/fixtures/', import.meta.url);

export async function fixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

describe('parseMessage', () => {
	it('reads a base64 HTML newsletter with an encoded subject', async () => {
		const m = await parseMessage(await fixture('newsletter.eml'));

		expect(m.subject).toBe('Tablón de Gómez Project 🇨🇴');
		expect(m.messageId).toBe('6BhDGbtpS4yIS8fcac4iTw@geopod-ismtpd-13');
		expect(m.date).toBe('2026-09-06T09:12:32.000Z');
		expect(m.from).toEqual({
			name: 'Ineffable Roasters',
			address: 'news_alias_r9z2ccjdx363mn@relay.example.test'
		});
		expect(m.to).toEqual([{ name: 'Hide My Email', address: 'alias.02garras@relay.example.org' }]);
		expect(m.html).toContain('<h1>Tablón de Gómez Project</h1>');
		// No text part: the text is derived from the HTML, hidden preheader included.
		expect(m.text).toContain('Un Honey de Nariño elegante y expresivo');
		expect(m.text).toContain('Comprar ahora');
		expect(m.text).not.toContain('<');
		expect(m.attachments).toEqual([]);
	});

	it('tells an attached file from an inline image in a related container', async () => {
		const m = await parseMessage(await fixture('report.eml'));

		expect(m.attachments).toEqual([
			{ name: 'logo.png', type: 'image/png', size: expect.any(Number), inline: true, index: 0 },
			{
				name: 'charging-summary-august.pdf',
				type: 'application/pdf',
				size: expect.any(Number),
				inline: false,
				index: 1
			}
		]);
		expect(m.text).toContain('Total energy: 184 kWh over 12 sessions.');
	});

	it('reads threading headers and a plain text body', async () => {
		const m = await parseMessage(await fixture('reply.eml'));

		expect(m.inReplyTo).toBe('HWnqaDLqScir3bd-3iy5ag@geopod-ismtpd-12');
		expect(m.references).toEqual(['HWnqaDLqScir3bd-3iy5ag@geopod-ismtpd-12']);
		expect(m.cc).toEqual([{ name: 'Someone Else', address: 'else@example.net' }]);
		expect(m.html).toBeNull();
		expect(m.text).toContain('Señal recibida.');
		expect(m.date).toBe('2026-09-02T07:05:00.000Z');
	});

	it('rejects bytes that are not a message', async () => {
		await expect(parseMessage(new Uint8Array())).rejects.toThrow(MessageParseError);
		await expect(parseMessage(await fixture('no-headers.eml'))).rejects.toThrow(MessageParseError);
	});
});

describe('snippetOf', () => {
	it('flattens whitespace and cuts with an ellipsis', () => {
		expect(snippetOf('  a\n\n b\tc ')).toBe('a b c');
		const long = 'word '.repeat(60);
		expect(snippetOf(long)).toHaveLength(160);
		expect(snippetOf(long).endsWith('…')).toBe(true);
	});
});
