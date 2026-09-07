/**
 * What onboarding carries from one screen to the next. The recovery phrase
 * exists only here between Create account and Recovery key, and again when
 * Settings regenerates it: it is shown once and forgotten as soon as the
 * user confirms it is stored, or at lock. A reload loses it, which is the
 * case Recovery key has to handle.
 */
class Onboarding {
	recoveryPhrase = $state<string | null>(null);

	/** Returns the phrase and forgets it. */
	takeRecoveryPhrase(): string | null {
		const phrase = this.recoveryPhrase;
		this.recoveryPhrase = null;
		return phrase;
	}
}

export const onboarding = new Onboarding();
