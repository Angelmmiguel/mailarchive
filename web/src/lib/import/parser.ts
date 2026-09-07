/**
 * Main-thread side of the parse worker. One worker serves a run; the
 * requests are numbered so replies find their caller. Cancel terminates
 * the worker and settles every pending request, so a message that keeps
 * the worker busy forever cannot keep the run alive; a request that takes
 * longer than `PREPARE_TIMEOUT` is failed the same way, since a worker the
 * browser killed for memory never reports back. Where `Worker` does not
 * exist (node, tests) the same code runs inline.
 */
import { prepare, type Prepared, type PrepareReply } from './prepare';
import type { PrepareRequest } from './parse.worker';

export const PREPARE_TIMEOUT = 60_000;

export interface Parser {
	/** Takes ownership of `bytes`: the buffer may be transferred away. */
	prepare(bytes: Uint8Array): Promise<Prepared>;
	/** Stops the worker; pending requests reject with `ParserClosedError`. */
	close(): void;
}

export class ParserClosedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'ParserClosedError';
	}
}

export function inlineParser(): Parser {
	return { prepare, close: () => {} };
}

interface Waiting {
	resolve: (p: Prepared) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function workerParser(timeout = PREPARE_TIMEOUT): Parser {
	if (typeof Worker === 'undefined') return inlineParser();
	const pending = new Map<number, Waiting>();
	let worker: Worker | null = null;
	let seq = 0;

	const settleAll = (error: Error): void => {
		for (const waiting of pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(error);
		}
		pending.clear();
	};

	const stop = (reason: string): void => {
		worker?.terminate();
		worker = null;
		settleAll(new ParserClosedError(reason));
	};

	const start = (): Worker => {
		const w = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (event: MessageEvent<PrepareReply & { seq: number }>) => {
			const waiting = pending.get(event.data.seq);
			if (waiting === undefined) return;
			pending.delete(event.data.seq);
			clearTimeout(waiting.timer);
			if ('error' in event.data) waiting.reject(new Error(event.data.error));
			else waiting.resolve(event.data);
		};
		w.onerror = (event) => stop(event.message || 'parse worker failed');
		return w;
	};

	return {
		prepare(bytes) {
			return new Promise<Prepared>((resolve, reject) => {
				worker ??= start();
				const id = ++seq;
				const timer = setTimeout(() => {
					// The worker is not answering: give up on everything it holds
					// and start a fresh one for the next file.
					pending.delete(id);
					stop('parsing took too long');
					reject(new Error('parsing took too long'));
				}, timeout);
				pending.set(id, { resolve, reject, timer });
				const buffer =
					bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
						? (bytes.buffer as ArrayBuffer)
						: bytes.slice().buffer;
				const request: PrepareRequest = { seq: id, bytes: buffer };
				worker.postMessage(request, { transfer: [buffer] });
			});
		},
		close() {
			stop('import cancelled');
		}
	};
}
