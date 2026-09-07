import { describe, expect, it } from 'vitest';
import { compress, decompress, DecompressedTooLargeError, MAX_DECOMPRESSED } from './compress';

describe('compress', () => {
	it('round-trips and shrinks repetitive input', async () => {
		const input = new TextEncoder().encode('Received: from somewhere\r\n'.repeat(200));
		const packed = await compress(input);

		expect(packed.length).toBeLessThan(input.length / 10);
		expect(await decompress(packed)).toEqual(input);
	});

	it('round-trips empty input', async () => {
		expect(await decompress(await compress(new Uint8Array()))).toEqual(new Uint8Array());
	});

	it('rejects bytes that are not gzip', async () => {
		await expect(decompress(new Uint8Array([1, 2, 3]))).rejects.toThrow();
	});
	it('refuses output above the cap', async () => {
		const bomb = await compress(new Uint8Array(MAX_DECOMPRESSED + 1));

		await expect(decompress(bomb)).rejects.toThrow(DecompressedTooLargeError);
	}, 60_000);
});
