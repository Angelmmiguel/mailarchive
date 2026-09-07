/**
 * gzip through the browser's native streams, applied to every plaintext
 * before it is sealed: raw messages, views, segment indexes and shards.
 * Compression happens inside the encryption boundary, so the server sees
 * only sealed sizes.
 */
import type { Bytes } from '$lib/api/types';

export function compress(plaintext: Uint8Array): Promise<Bytes> {
	return through(new CompressionStream('gzip'), plaintext);
}

/** Largest plaintext `decompress` will produce; a gzip can expand a thousandfold. */
export const MAX_DECOMPRESSED = 256 * 1024 * 1024;

export class DecompressedTooLargeError extends Error {
	constructor() {
		super(`decompressed data exceeds ${MAX_DECOMPRESSED} bytes`);
		this.name = 'DecompressedTooLargeError';
	}
}

export async function decompress(compressed: Uint8Array): Promise<Bytes> {
	const stream = new DecompressionStream('gzip');
	const writer = stream.writable.getWriter();
	// A bad or oversized input surfaces through the reader; the writer's own
	// rejection would otherwise go unobserved.
	const written = writer
		.write(compressed as Uint8Array<ArrayBuffer>)
		.then(() => writer.close())
		.catch(() => {});
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_DECOMPRESSED) {
			await reader.cancel();
			throw new DecompressedTooLargeError();
		}
		chunks.push(value);
	}
	await written;
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

async function through(
	transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
	bytes: Uint8Array
): Promise<Bytes> {
	const writer = transform.writable.getWriter();
	const written = writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
	const [out] = await Promise.all([new Response(transform.readable).arrayBuffer(), written]);
	return new Uint8Array(out);
}
