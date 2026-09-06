import { beforeEach, describe, expect, it } from 'vitest';
import { onboarding } from './onboarding.svelte';

beforeEach(() => {
	onboarding.recoveryPhrase = null;
});

describe('takeRecoveryPhrase', () => {
	it('hands the phrase out once', () => {
		onboarding.recoveryPhrase = 'a b c';

		expect(onboarding.takeRecoveryPhrase()).toBe('a b c');
		expect(onboarding.recoveryPhrase).toBeNull();
		expect(onboarding.takeRecoveryPhrase()).toBeNull();
	});
});
