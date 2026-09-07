/**
 * The worker client against a fake `Worker`, since node has none: replies
 * are routed by sequence number, cancel settles what is pending, and a
 * silent worker is given up on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParserClosedError, workerParser } from './parser';

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	posted: { seq: number; bytes: ArrayBuffer }[] = [];
	terminated = false;

	constructor() {
		FakeWorker.instances.push(this);
	}

	postMessage(request: { seq: number; bytes: ArrayBuffer }): void {
		this.posted.push(request);
	}

	terminate(): void {
		this.terminated = true;
	}

	reply(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}
}

beforeEach(() => {
	FakeWorker.instances = [];
	vi.stubGlobal('Worker', FakeWorker);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('workerParser', () => {
	it('routes replies by sequence and transfers the buffer', async () => {
		const parser = workerParser();
		const first = parser.prepare(new Uint8Array([1, 2, 3]));
		const second = parser.prepare(new Uint8Array([4]));
		const worker = FakeWorker.instances[0]!;
		expect(worker.posted.map((p) => p.seq)).toEqual([1, 2]);

		worker.reply({ seq: 2, snippet: 'two' });
		worker.reply({ seq: 1, error: 'bad' });

		await expect(second).resolves.toMatchObject({ snippet: 'two' });
		await expect(first).rejects.toThrow('bad');
	});

	it('cancel terminates the worker and settles every pending request', async () => {
		const parser = workerParser();
		const pending = parser.prepare(new Uint8Array([1]));

		parser.close();

		await expect(pending).rejects.toThrow(ParserClosedError);
		expect(FakeWorker.instances[0]!.terminated).toBe(true);
	});

	it('gives up on a worker that never answers and starts a fresh one', async () => {
		const parser = workerParser(1000);
		const stuck = parser.prepare(new Uint8Array([1]));
		vi.advanceTimersByTime(1000);

		await expect(stuck).rejects.toThrow('parsing took too long');
		expect(FakeWorker.instances[0]!.terminated).toBe(true);

		const next = parser.prepare(new Uint8Array([2]));
		expect(FakeWorker.instances).toHaveLength(2);
		FakeWorker.instances[1]!.reply({ seq: 2, snippet: 'ok' });
		await expect(next).resolves.toMatchObject({ snippet: 'ok' });
	});
});
