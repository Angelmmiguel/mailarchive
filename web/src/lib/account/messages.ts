/**
 * Opening one message from the archive: the view blob when it is read,
 * the raw blob for the original file and its attachments. Views are kept
 * for a while so that collapsing and expanding a message in a thread does
 * not fetch it twice; lock forgets them with everything else.
 */
import PostalMime from 'postal-mime';
import type { Bytes } from '$lib/api/types';
import { decryptBlob } from '$lib/crypto/blob';
import { decompress } from '$lib/crypto/compress';
import type { MessageView } from '$lib/import/prepare';
import type { IndexRecord } from '$lib/index/records';
import { MAX_HEADERS_BYTES, MAX_NESTING, type AttachmentMeta } from '$lib/mail/message';
import { session } from '$lib/state/session.svelte';
import { defaultDeps, type Deps } from './deps';
import { call, LockedError } from './errors';

/** The index points at a blob the server does not have. */
export class MissingBlobError extends Error {
	constructor(id: string) {
		super(`blob ${id.slice(0, 8)}… is listed in the index but not stored`);
		this.name = 'MissingBlobError';
	}
}

/** A blob opened fine but does not hold what the index says it does. */
export class MessageFormatError extends Error {
	constructor(detail: string) {
		super(`malformed message: ${detail}`);
		this.name = 'MessageFormatError';
	}
}

export interface AttachmentFile {
	name: string;
	type: string;
	bytes: Uint8Array;
}

export const VIEW_CACHE = 32;

const views = new Map<string, Promise<MessageView>>();

export function openMessage(
	record: Pick<IndexRecord, 'view'>,
	deps: Pick<Deps, 'api'> = defaultDeps
): Promise<MessageView> {
	const cached = views.get(record.view);
	if (cached !== undefined) return cached;
	const view = openBlob(record.view, deps).then(decodeView);
	views.set(record.view, view);
	view.catch(() => views.delete(record.view));
	if (views.size > VIEW_CACHE) {
		const oldest = views.keys().next().value;
		if (oldest !== undefined) views.delete(oldest);
	}
	return view;
}

/** The original `.eml` bytes. */
export function openOriginal(
	record: Pick<IndexRecord, 'id'>,
	deps: Pick<Deps, 'api'> = defaultDeps
): Promise<Bytes> {
	return openBlob(record.id, deps);
}

/** One part of the original, parsed again from the raw bytes. */
export async function openAttachment(
	record: Pick<IndexRecord, 'id'>,
	meta: AttachmentMeta,
	deps: Pick<Deps, 'api'> = defaultDeps
): Promise<AttachmentFile> {
	const raw = await openOriginal(record, deps);
	const email = await PostalMime.parse(raw, {
		attachmentEncoding: 'arraybuffer',
		maxNestingDepth: MAX_NESTING,
		maxHeadersSize: MAX_HEADERS_BYTES
	});
	const part = email.attachments[meta.index];
	if (part === undefined) throw new MessageFormatError(`no attachment ${meta.index}`);
	return { name: meta.name, type: meta.type, bytes: toBytes(part.content) };
}

export function forgetMessages(): void {
	views.clear();
}

async function openBlob(id: string, deps: Pick<Deps, 'api'>): Promise<Bytes> {
	const keys = session.keys;
	if (session.status !== 'unlocked' || keys === null) throw new LockedError();
	const sealed = await call(deps.api.getBlob(id));
	// A lock during either wait zeroed `keys` and forgot the messages:
	// nothing opened here may outlive it.
	const live = (): void => {
		if (session.keys !== keys) throw new LockedError();
	};
	live();
	if (sealed === null) throw new MissingBlobError(id);
	const plaintext = await decompress(decryptBlob(keys, id, sealed));
	live();
	return plaintext;
}

function decodeView(plaintext: Bytes): MessageView {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
	} catch {
		throw new MessageFormatError('not JSON');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new MessageFormatError('not an object');
	}
	const view = parsed as Record<string, unknown>;
	if (
		view.version !== 1 ||
		typeof view.text !== 'string' ||
		(view.html !== null && typeof view.html !== 'string') ||
		!Array.isArray(view.attachments)
	) {
		throw new MessageFormatError('not a message view');
	}
	return view as unknown as MessageView;
}

/** The parts an HTML body embeds by content id, as object URLs. */
export async function openInlineImages(
	record: Pick<IndexRecord, 'id'>,
	deps: Pick<Deps, 'api'> = defaultDeps
): Promise<Map<string, AttachmentFile>> {
	const raw = await openOriginal(record, deps);
	const email = await PostalMime.parse(raw, {
		attachmentEncoding: 'arraybuffer',
		maxNestingDepth: MAX_NESTING,
		maxHeadersSize: MAX_HEADERS_BYTES
	});
	const parts = new Map<string, AttachmentFile>();
	for (const part of email.attachments) {
		if (part.contentId === undefined || !part.mimeType.startsWith('image/')) continue;
		const id = part.contentId.trim().replace(/^<|>$/g, '');
		if (id === '' || parts.has(id)) continue;
		parts.set(id, { name: part.filename ?? id, type: part.mimeType, bytes: toBytes(part.content) });
	}
	return parts;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof content === 'string') return new TextEncoder().encode(content);
	return content instanceof Uint8Array ? content : new Uint8Array(content);
}
