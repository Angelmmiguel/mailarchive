/**
 * The key-free half of importing one message: parse it, build the view
 * that a reader fetches instead of the raw bytes, gather its search terms
 * and compress the original. Runs in the worker in the browser and inline
 * in tests.
 */
import type { Bytes } from '$lib/api/types';
import { compress } from '$lib/crypto/compress';
import { parseMessage, snippetOf, type ParsedMessage } from '$lib/mail/message';
import { termsOf, type Term } from '$lib/mail/tokenize';

/** What the view blob holds: the message without its raw MIME. */
export interface MessageView extends Omit<ParsedMessage, 'text' | 'html'> {
	version: 1;
	text: string;
	html: string | null;
}

export interface Prepared {
	/** Headers and metadata, without bodies. */
	message: Omit<ParsedMessage, 'text' | 'html'>;
	snippet: string;
	terms: Term[];
	/** The view, JSON, gzip-compressed. */
	view: Bytes;
	/** The original bytes, gzip-compressed. */
	raw: Bytes;
}

export type PrepareReply = Prepared | { error: string };

export async function prepare(bytes: Uint8Array): Promise<Prepared> {
	const parsed = await parseMessage(bytes);
	const { text, html, ...message } = parsed;
	const view: MessageView = { version: 1, ...message, text, html };
	const [viewBytes, raw] = await Promise.all([
		compress(new TextEncoder().encode(JSON.stringify(view))),
		compress(bytes)
	]);
	return { message, snippet: snippetOf(text), terms: termsOf(parsed), view: viewBytes, raw };
}
