/**
 * Thread grouping from Message-ID, In-Reply-To and References. A message
 * joins the thread of the first ancestor the archive already knows; if it
 * knows none, the oldest id it references names a new thread, so that
 * replies imported before their root still end up together.
 */
import type { ParsedMessage } from './message';

/** Message-ID header → thread id, for every message known so far. */
export type ThreadMap = Map<string, string>;

export function threadIdFor(
	message: Pick<ParsedMessage, 'messageId' | 'inReplyTo' | 'references'>,
	known: ThreadMap,
	fallback: string
): string {
	const ancestors = [...message.references, message.inReplyTo].filter((id) => id !== null);
	for (const id of ancestors) {
		const thread = known.get(id);
		if (thread !== undefined) return thread;
	}
	return ancestors[0] ?? message.messageId ?? fallback;
}
