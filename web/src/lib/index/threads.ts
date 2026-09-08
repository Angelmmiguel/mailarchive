/**
 * Threads for the list: the records grouped by thread id and summarised,
 * newest thread first. A thread is named in the URL by an HMAC of its id
 * under the id key, so a hard reload sends the server an opaque name
 * rather than a Message-ID, and every device derives the same name.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ATTACHMENTS, isOwn, labelsFor, SENT } from '$lib/mail/labels';
import type { Address } from '$lib/mail/message';
import type { IndexRecord } from './records';

export interface Thread {
	id: string;
	/** The subject of the newest message, or of the first that has one. */
	subject: string;
	/** Oldest first; messages without a date come last. */
	messages: IndexRecord[];
	/** The newest message: its snippet and date represent the thread. */
	latest: IndexRecord;
	/** Non-inline parts across every message. */
	attachments: number;
	labels: string[];
}

export const NO_SUBJECT = '(no subject)';

/** `own` are the user's addresses, which decide the `sent` label. */
export function groupThreads(records: IndexRecord[], own: string[]): Thread[] {
	const groups = new Map<string, IndexRecord[]>();
	for (const record of records) {
		const group = groups.get(record.threadId);
		if (group === undefined) groups.set(record.threadId, [record]);
		else group.push(record);
	}
	const threads: Thread[] = [];
	for (const [id, messages] of groups) {
		messages.sort(byDate);
		const dated = messages.filter((m) => m.date !== null);
		const latest = dated[dated.length - 1] ?? messages[messages.length - 1];
		const labels = [SENT, ATTACHMENTS].filter((label) =>
			messages.some((m) => labelsFor(m, own).includes(label))
		);
		threads.push({
			id,
			subject: latest.subject || messages.find((m) => m.subject !== '')?.subject || NO_SUBJECT,
			messages,
			latest,
			attachments: messages.reduce((n, m) => n + m.attachments.filter((a) => !a.inline).length, 0),
			labels
		});
	}
	// Newest first, threads without any date last, ties broken by id so
	// that the order is stable across devices.
	threads.sort(
		(a, b) => byDate(b.latest, a.latest, true) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
	return threads;
}

/** Ascending by date; undated after everything dated in both directions. */
export function byDate(
	a: { date: string | null },
	b: { date: string | null },
	reversed: boolean = false
): number {
	if (a.date === b.date) return 0;
	if (a.date === null) return reversed ? -1 : 1;
	if (b.date === null) return reversed ? 1 : -1;
	return a.date < b.date ? -1 : 1;
}

/**
 * Who took part, for a row: the senders in order of first appearance, the
 * user as "me". A thread the user alone wrote names its recipients instead.
 */
export function participantsOf(thread: Thread, own: string[]): string {
	const senders: string[] = [];
	let onlyOwn = true;
	for (const message of thread.messages) {
		if (message.from === null) {
			onlyOwn = false;
			push(senders, 'unknown');
		} else if (isOwn(message.from.address, own)) {
			push(senders, 'me');
		} else {
			onlyOwn = false;
			push(senders, shortName(message.from));
		}
	}
	if (onlyOwn) {
		const recipients: string[] = [];
		for (const message of thread.messages) {
			for (const address of [...message.to, ...message.cc]) {
				if (!isOwn(address.address, own)) push(recipients, shortName(address));
			}
		}
		if (recipients.length > 0) return `to ${recipients.join(', ')}`;
	}
	return senders.join(', ');
}

/** The display name, or the local part of the address without one. */
export function shortName(address: Address): string {
	const name = address.name.trim();
	if (name !== '') return name;
	const at = address.address.indexOf('@');
	return at > 0 ? address.address.slice(0, at) : address.address;
}

function push(list: string[], name: string): void {
	if (!list.includes(name)) list.push(name);
}

/** `HMAC-SHA256(id key, "thread/<thread id>")`, hex: the thread's name in the URL. */
export function threadKey(idKey: Uint8Array, threadId: string): string {
	return bytesToHex(hmac(sha256, idKey, new TextEncoder().encode(`thread/${threadId}`)));
}

export const THREAD_KEY = /^[0-9a-f]{64}$/;
