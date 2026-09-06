/**
 * What an account flow can fail with, in terms a screen can act on. The
 * crypto errors (`SealError`, `InvalidRecoveryPhraseError`, the passphrase
 * length errors, `ManifestFormatError`) pass through unchanged.
 */
import { ApiError, type ServerErrorCode } from '$lib/api/types';

/** The archive has no account yet. */
export class NotSetUpError extends Error {
	constructor() {
		super('this archive has no account yet');
		this.name = 'NotSetUpError';
	}
}

/** The archive already has its one account. */
export class AlreadySetUpError extends Error {
	constructor() {
		super('this archive already has an account');
		this.name = 'AlreadySetUpError';
	}
}

/** The server rejected the auth key derived from the passphrase. */
export class WrongPassphraseError extends Error {
	constructor() {
		super('wrong passphrase');
		this.name = 'WrongPassphraseError';
	}
}

/** A well-formed recovery phrase that does not belong to this archive. */
export class WrongRecoveryKeyError extends Error {
	constructor() {
		super('this recovery phrase does not belong to this archive');
		this.name = 'WrongRecoveryKeyError';
	}
}

/** Too many attempts; wait before the next one. */
export class RateLimitedError extends Error {
	constructor() {
		super('too many attempts, try again later');
		this.name = 'RateLimitedError';
	}
}

/** The server no longer holds the session; unlock again. */
export class SessionExpiredError extends Error {
	constructor() {
		super('the session has expired, unlock again');
		this.name = 'SessionExpiredError';
	}
}

/** The request never reached the server. */
export class ServerUnreachableError extends Error {
	constructor(cause: unknown) {
		super('the server cannot be reached', { cause });
		this.name = 'ServerUnreachableError';
	}
}

/**
 * The server has an account but no manifest. Setup writes the manifest
 * before the credentials, so this cannot come from an interrupted setup;
 * the manifest was lost afterwards, and without its wrapped DEK nothing can
 * open the archive.
 */
export class MissingManifestError extends Error {
	constructor() {
		super('the server has an account but no manifest, so the archive cannot be opened');
		this.name = 'MissingManifestError';
	}
}

/** The operation needs an unlocked session. */
export class LockedError extends Error {
	constructor() {
		super('the archive is locked');
		this.name = 'LockedError';
	}
}

/**
 * Awaits one API call, translating the failures every flow treats the same
 * way. A 401 here comes from a route that only needed the session, so the
 * session is gone.
 */
export async function call<T>(request: Promise<T>): Promise<T> {
	try {
		return await request;
	} catch (e) {
		throw translate(e);
	}
}

/**
 * `call` for a request that presents a credential: a 401 with `code`, the
 * code the route answers for a rejected credential, becomes the error
 * `wrong` builds, since only the caller knows whether a passphrase or a
 * recovery phrase was being judged. Login rejects with `unauthorized`,
 * rekey with `wrong_credential`; any other 401 means the session is gone.
 */
export async function callAs<T>(
	request: Promise<T>,
	wrong: () => Error,
	code: ServerErrorCode
): Promise<T> {
	try {
		return await request;
	} catch (e) {
		if (e instanceof ApiError && e.status === 401 && e.code === code) throw wrong();
		throw translate(e);
	}
}

/**
 * `fetch` rejects with a TypeError when the network fails, which is the only
 * TypeError a client call can produce.
 */
function translate(e: unknown): unknown {
	if (e instanceof TypeError) return new ServerUnreachableError(e);
	if (!(e instanceof ApiError)) return e;
	switch (e.code) {
		case 'not_setup':
			return new NotSetUpError();
		case 'already_setup':
			return new AlreadySetUpError();
		case 'rate_limited':
			return new RateLimitedError();
	}
	return e.status === 401 ? new SessionExpiredError() : e;
}
