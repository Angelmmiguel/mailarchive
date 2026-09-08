/**
 * The segment index: one record per message, everything a list needs
 * without fetching the message. Records are immutable once a segment is
 * written; the merged index in memory is the union of every segment.
 */
import type { Address, AttachmentMeta } from '$lib/mail/message';

export const INDEX_VERSION = 1;

export interface IndexRecord {
	/** The raw blob id: a keyed hash of the original bytes. */
	id: string;
	/** The Message-ID header, or null. Together with date and from it spots re-exports. */
	messageId: string | null;
	threadId: string;
	/** ISO 8601, or null when the message carried no readable date. */
	date: string | null;
	from: Address | null;
	to: Address[];
	cc: Address[];
	subject: string;
	snippet: string;
	/** Size of the original .eml in bytes. */
	size: number;
	attachments: AttachmentMeta[];
	/** The view blob id. */
	view: string;
}

/** The key under which a re-export of a message collides with the original. */
export function headerKey(record: {
	messageId: string | null;
	date: string | null;
	from: { address: string } | null;
}): string | null {
	if (record.messageId === null) return null;
	return `${record.messageId}\n${record.date ?? ''}\n${record.from?.address ?? ''}`;
}

/** What a segment index blob holds. */
export interface SegmentIndex {
	version: typeof INDEX_VERSION;
	records: IndexRecord[];
}

/** One posting: message id, field bits, frequency. */
export type Posting = [id: string, field: number, frequency: number];

/** What a term shard blob holds. */
export interface TermShard {
	version: typeof INDEX_VERSION;
	prefix: string;
	terms: Record<string, Posting[]>;
}
