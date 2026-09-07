/**
 * What the account flows reach outside for. Tests hand in a mocked client,
 * a synchronous derive with tiny parameters and parameters to match; the
 * app uses the real client, the worker and the production cost.
 */
import * as client from '$lib/api/client';
import type { Bytes } from '$lib/api/types';
import { blobCache, type BlobCache } from '$lib/cache/blobs';
import { deriveRootInWorker } from '$lib/crypto/kdf-client';
import { newKdfParams, type KdfParams } from '$lib/crypto/kdf';

export type Api = typeof client;

export interface Deps {
	api: Api;
	/** Where segment indexes and term shards are kept between unlocks. */
	cache: BlobCache;
	deriveRoot: (passphrase: string, params: KdfParams) => Promise<Bytes>;
	/** Parameters, salt included, for a passphrase that is being set. */
	newKdfParams: () => KdfParams;
}

export const defaultDeps: Deps = {
	api: client,
	cache: blobCache,
	deriveRoot: deriveRootInWorker,
	newKdfParams
};
