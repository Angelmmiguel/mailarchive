/**
 * Parses messages off the main thread: MIME, terms and the compressed raw
 * bytes, one request at a time per worker. No keys come here; naming and
 * sealing happen on the main thread.
 */
import { prepare, type PrepareReply } from './prepare';

export interface PrepareRequest {
	seq: number;
	bytes: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<PrepareRequest>) => {
	const { seq, bytes } = event.data;
	let reply: PrepareReply;
	try {
		reply = await prepare(new Uint8Array(bytes));
	} catch (e) {
		reply = { error: e instanceof Error ? e.message : String(e) };
	}
	const transfer =
		'raw' in reply ? [reply.raw.buffer as ArrayBuffer, reply.view.buffer as ArrayBuffer] : [];
	self.postMessage({ seq, ...reply }, { transfer });
};
