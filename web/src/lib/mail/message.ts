/**
 * What the archive keeps about one message, parsed once at import. The
 * parser is postal-mime, wrapped here so nothing else depends on its
 * shapes. Bodies stay as the sender wrote them; HTML is sanitized where
 * it is rendered, never stored as trusted.
 */
import PostalMime, { type Address as MimeAddress, type Email } from 'postal-mime';
import { htmlToText } from './text';

export interface Address {
	name: string;
	address: string;
}

export interface AttachmentMeta {
	name: string;
	type: string;
	size: number;
	/** Referenced from the HTML body (cid) rather than offered as a file. */
	inline: boolean;
	/** Position among the parsed attachments, for extracting it from raw. */
	index: number;
}

export interface ParsedMessage {
	/** The Message-ID header, angle brackets stripped, or null. */
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	/**
	 * ISO 8601. Without a readable Date header, the time of the newest
	 * Received hop, which is when the message reached the mailbox; null
	 * when there is neither.
	 */
	date: string | null;
	from: Address | null;
	to: Address[];
	cc: Address[];
	subject: string;
	/** The plain text body, derived from HTML when there is no text part. */
	text: string;
	html: string | null;
	attachments: AttachmentMeta[];
}

/** Bytes that are not an email this code can read. */
export class MessageParseError extends Error {
	constructor(detail: string) {
		super(`cannot parse message: ${detail}`);
		this.name = 'MessageParseError';
	}
}

export const SNIPPET_LENGTH = 160;
/** Tighter than the parser's defaults; real mail is nowhere near either. */
export const MAX_NESTING = 32;
export const MAX_HEADERS_BYTES = 256 * 1024;

export async function parseMessage(bytes: Uint8Array): Promise<ParsedMessage> {
	if (bytes.length === 0) throw new MessageParseError('empty file');
	let email: Email;
	try {
		email = await PostalMime.parse(bytes, {
			attachmentEncoding: 'arraybuffer',
			maxNestingDepth: MAX_NESTING,
			maxHeadersSize: MAX_HEADERS_BYTES
		});
	} catch (e) {
		throw new MessageParseError(e instanceof Error ? e.message : String(e));
	}
	const from = email.from === undefined ? null : (mailboxes([email.from])[0] ?? null);
	if (email.headers.length === 0 || (from === null && email.subject === undefined)) {
		throw new MessageParseError('no headers');
	}
	const html = email.html ?? null;
	const text = email.text?.trim() ? email.text : html === null ? '' : htmlToText(html);
	return {
		messageId: stripId(email.messageId),
		inReplyTo: stripId(email.inReplyTo),
		references: (email.references ?? '')
			.split(/\s+/)
			.map((id) => stripId(id))
			.filter((id): id is string => id !== null),
		date: isoDate(email.date) ?? receivedDate(email.headers),
		from,
		to: mailboxes(email.to ?? []),
		cc: mailboxes(email.cc ?? []),
		subject: email.subject ?? '',
		text,
		html,
		attachments: email.attachments.map((a, index) => ({
			name: a.filename ?? `part-${index + 1}`,
			type: a.mimeType,
			size: byteLength(a.content),
			inline: a.disposition === 'inline' || (a.related === true && a.contentId !== undefined),
			index
		}))
	};
}

/** The first line or so of the text, for lists. */
export function snippetOf(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= SNIPPET_LENGTH ? flat : `${flat.slice(0, SNIPPET_LENGTH - 1)}…`;
}

function stripId(value: string | undefined): string | null {
	if (value === undefined) return null;
	const id = value.trim().replace(/^<|>$/g, '');
	return id === '' ? null : id;
}

function isoDate(value: string | undefined): string | null {
	if (value === undefined) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The date of the first Received header that has one. Each hop prepends
 * its own line, so the first is the last server the message passed, and
 * its timestamp follows the final semicolon.
 */
function receivedDate(headers: { key: string; value: string }[]): string | null {
	for (const header of headers) {
		if (header.key !== 'received') continue;
		const at = header.value.lastIndexOf(';');
		if (at === -1) continue;
		const date = isoDate(header.value.slice(at + 1).trim());
		if (date !== null) return date;
	}
	return null;
}

/** Flattens groups and drops entries without an address. */
function mailboxes(list: MimeAddress[]): Address[] {
	const out: Address[] = [];
	for (const entry of list) {
		if (entry.group !== undefined) {
			out.push(...mailboxes(entry.group));
		} else if (entry.address !== undefined && entry.address !== '') {
			out.push({ name: entry.name, address: entry.address.toLowerCase() });
		}
	}
	return out;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
	if (typeof content === 'string') return new TextEncoder().encode(content).length;
	return content.byteLength;
}
