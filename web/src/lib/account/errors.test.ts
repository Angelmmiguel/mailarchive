import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/types';
import {
	AlreadySetUpError,
	call,
	callAs,
	NotSetUpError,
	RateLimitedError,
	ServerUnreachableError,
	SessionExpiredError
} from './errors';

describe('call', () => {
	it('passes a result through', async () => {
		await expect(call(Promise.resolve(42))).resolves.toBe(42);
	});

	it.each([
		{ code: 'not_setup', status: 409, want: NotSetUpError },
		{ code: 'already_setup', status: 409, want: AlreadySetUpError },
		{ code: 'rate_limited', status: 429, want: RateLimitedError }
	] as const)('maps $code to $want.name', async ({ code, status, want }) => {
		await expect(call(Promise.reject(new ApiError(status, code)))).rejects.toThrow(want);
	});

	it('maps a network failure to ServerUnreachableError, keeping the cause', async () => {
		const cause = new TypeError('fetch failed');

		const error = await call(Promise.reject(cause)).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ServerUnreachableError);
		expect(error).toMatchObject({ cause });
	});

	it('maps any 401 to SessionExpiredError', async () => {
		await expect(call(Promise.reject(new ApiError(401, 'unauthorized')))).rejects.toThrow(
			SessionExpiredError
		);
	});

	it('leaves other API errors as they are', async () => {
		const error = new ApiError(403, 'forbidden');

		await expect(call(Promise.reject(error))).rejects.toBe(error);
	});

	it('leaves other errors as they are', async () => {
		const error = new RangeError('nope');

		await expect(call(Promise.reject(error))).rejects.toBe(error);
	});
});

describe('callAs', () => {
	const wrong = () => new RangeError('wrong');

	it('passes a result through', async () => {
		await expect(callAs(Promise.resolve(42), wrong, 'unauthorized')).resolves.toBe(42);
	});

	it('maps a 401 with the given code to the wrong-credential error', async () => {
		const request = Promise.reject(new ApiError(401, 'wrong_credential'));

		await expect(callAs(request, wrong, 'wrong_credential')).rejects.toThrow(RangeError);
	});

	it('maps a 401 with any other code to SessionExpiredError', async () => {
		const request = Promise.reject(new ApiError(401, 'unauthorized'));

		await expect(callAs(request, wrong, 'wrong_credential')).rejects.toThrow(SessionExpiredError);
	});

	it('translates the shared failures like call', async () => {
		const request = Promise.reject(new ApiError(429, 'rate_limited'));

		await expect(callAs(request, wrong, 'unauthorized')).rejects.toThrow(RateLimitedError);
	});
});
