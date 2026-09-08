/**
 * Error codes the server sends as `{"error":"<code>"}`. Mirrors the `code*`
 * constants in internal/server/handlers.go.
 */
export type ServerErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'wrong_credential'
	| 'forbidden'
	| 'header_locked'
	| 'not_found'
	| 'not_setup'
	| 'already_setup'
	| 'invalid_id'
	| 'invalid_auth_key'
	| 'invalid_kdf'
	| 'invalid_session_key'
	| 'exists'
	| 'too_large'
	| 'too_many_ids'
	| 'rate_limited'
	| 'conflict'
	| 'if_match_required'
	| 'internal';

/**
 * A server code, `unknown` when the response carried no JSON error code, or
 * `malformed` when a successful response did not have the shape the route
 * promises.
 */
export type ErrorCode = ServerErrorCode | 'unknown' | 'malformed';

/**
 * The byte buffers this API deals in. Spelling the backing store out excludes
 * views over shared memory, which `fetch` refuses as a request body.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Answer of `GET /api/health`. */
export interface Health {
	status: 'ok';
	setup: boolean;
}

/** The encrypted manifest and the ETag that guards the next write. */
export interface Manifest {
	data: Bytes;
	etag: string;
}

/** Whether `PUT /api/blobs/<id>` stored the body or found the id taken. */
export type PutBlobResult = 'created' | 'exists';

/** A response the client did not expect. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ErrorCode;

	constructor(status: number, code: ErrorCode) {
		super(`mailarchive API: ${status} ${code}`);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}
