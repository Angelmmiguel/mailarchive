/**
 * Thread grouping. A message joins the thread of the first ancestor the
 * archive already knows, by Message-ID, In-Reply-To and References; if it
 * knows none, the oldest id it references names a new thread, so that
 * replies imported before their root still end up together.
 *
 * Some exports carry none of those headers: a sent folder dumped without
 * Message-ID or References cannot be linked by id at all. For a message
 * with no known ancestor the subject is the fallback: stripped of reply
 * and forward prefixes, it joins the nearest thread with the same subject
 * that shares a correspondent other than the user, within a window. A
 * reply may join any such thread; a message that is not a reply joins
 * only a thread that already holds replies, which keeps a monthly
 * notification with an unchanging subject from chaining into one thread.
 */
import type { Address, ParsedMessage } from './message';
import { isOwn } from './labels';

/** Message-ID header → thread id, for every message known so far. */
export type ThreadMap = Map<string, string>;

/** How far apart, in either direction, a subject may still join a thread. */
export const SUBJECT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type Threadable = Pick<
	ParsedMessage,
	'messageId' | 'inReplyTo' | 'references' | 'subject' | 'date' | 'from' | 'to' | 'cc'
>;

/** What an archived record still tells about a message, which is all seeding needs. */
export type Remembered = Omit<Threadable, 'inReplyTo' | 'references'>;

interface SubjectEntry {
	threadId: string;
	/** The newest message of the thread under this subject, in ms. */
	time: number;
	participants: Set<string>;
	/** Whether the thread holds a reply, which a non-reply may then join. */
	replies: boolean;
}

/**
 * Threads the messages of one import, seeded with what the archive
 * already holds. `own` is the user's addresses, which never count as the
 * shared correspondent.
 */
export class Threader {
	private readonly byMessageId: ThreadMap = new Map();
	private readonly bySubject = new Map<string, SubjectEntry[]>();

	constructor(
		private readonly own: string[],
		known: Iterable<Remembered & { threadId: string }> = []
	) {
		for (const record of known) this.remember(record, record.threadId);
	}

	/** The thread `message` belongs to, which it joins from now on. */
	assign(message: Threadable, fallback: string): string {
		const threadId = this.find(message, fallback);
		this.remember(message, threadId);
		return threadId;
	}

	private find(message: Threadable, fallback: string): string {
		const ancestors = [...message.references, message.inReplyTo].filter((id) => id !== null);
		for (const id of ancestors) {
			const thread = this.byMessageId.get(id);
			if (thread !== undefined) return thread;
		}
		return this.bySubjectOf(message) ?? ancestors[0] ?? message.messageId ?? fallback;
	}

	private bySubjectOf(message: Threadable): string | null {
		const { key, reply } = subjectKey(message.subject);
		const time = timeOf(message.date);
		if (key === '' || time === null) return null;
		const entries = this.bySubject.get(key);
		if (entries === undefined) return null;
		const people = correspondents(message, this.own);
		let best: SubjectEntry | null = null;
		for (const entry of entries) {
			if (!reply && !entry.replies) continue;
			if (Math.abs(entry.time - time) > SUBJECT_WINDOW_MS) continue;
			if (!people.some((p) => entry.participants.has(p))) continue;
			if (best === null || Math.abs(entry.time - time) < Math.abs(best.time - time)) best = entry;
		}
		return best?.threadId ?? null;
	}

	private remember(message: Remembered, threadId: string): void {
		if (message.messageId !== null && !this.byMessageId.has(message.messageId)) {
			this.byMessageId.set(message.messageId, threadId);
		}
		const { key, reply } = subjectKey(message.subject);
		const time = timeOf(message.date);
		if (key === '' || time === null) return;
		const people = correspondents(message, this.own);
		let entries = this.bySubject.get(key);
		if (entries === undefined) {
			entries = [];
			this.bySubject.set(key, entries);
		}
		const entry = entries.find((e) => e.threadId === threadId);
		if (entry === undefined) {
			entries.push({ threadId, time, participants: new Set(people), replies: reply });
			return;
		}
		entry.time = Math.max(entry.time, time);
		for (const p of people) entry.participants.add(p);
		entry.replies ||= reply;
	}
}

const PREFIX = /^\s*(?:(?:re|aw|sv|vs|fw|fwd|wg|tr|rv|enc)\s*(?:\[\d+\])?\s*:\s*)+/i;

/**
 * The subject without its reply and forward prefixes, lower-cased with
 * its whitespace flattened, and whether it had any.
 */
export function subjectKey(subject: string): { key: string; reply: boolean } {
	const stripped = subject.replace(PREFIX, '');
	return {
		key: stripped.trim().toLowerCase().replace(/\s+/g, ' '),
		reply: stripped.length !== subject.length
	};
}

function timeOf(date: string | null): number | null {
	if (date === null) return null;
	const time = Date.parse(date);
	return Number.isNaN(time) ? null : time;
}

/** Every address on the message that is not the user's, lower-cased. */
function correspondents(message: Remembered, own: string[]): string[] {
	const all: Address[] = [
		...(message.from === null ? [] : [message.from]),
		...message.to,
		...message.cc
	];
	const out = new Set<string>();
	for (const { address } of all) {
		const lower = address.toLowerCase();
		if (!isOwn(lower, own)) out.add(lower);
	}
	return [...out];
}
