<!--
  Create account, step 1 of onboarding. Collects the passphrase, calls
  `createAccount` and hands the recovery phrase to the next screen. A server
  that already has its account belongs to Unlock, which says why it was
  reached, or to the archive when the session is already open; the same
  happens when the server reports it at submit.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import {
		AlreadySetUpError,
		ServerUnreachableError,
		SetupUnfinishedError
	} from '$lib/account/errors';
	import { createAccount } from '$lib/account/setup';
	import { passphraseStrength } from '$lib/account/strength';
	import { Button, Field, Notice, PassphraseField, Step } from '$lib/components';
	import { archive } from '$lib/state/archive.svelte';
	import { onboarding } from '$lib/state/onboarding.svelte';
	import { session } from '$lib/state/session.svelte';

	let passphrase = $state('');
	let confirmation = $state('');
	let working = $state(false);
	let failure = $state<'unreachable' | 'unfinished' | 'unknown' | null>(null);

	const alreadySetUp = $derived(archive.health?.setup === true);
	const tooWeak = $derived(passphrase !== '' && passphraseStrength(passphrase).score === 0);
	const mismatch = $derived(confirmation !== '' && confirmation !== passphrase);
	const ready = $derived(
		passphrase !== '' && !tooWeak && confirmation === passphrase && !working && !alreadySetUp
	);

	// Unlock, told why it was reached so that it can say so after a reload
	// too. `ResolvedPathname` does not model a query string, hence the cast.
	const unlock = `${resolve('/unlock')}?reason=already-set-up` as ResolvedPathname;

	$effect(() => {
		if (session.status === 'unlocked') void goto(resolve('/'), { replaceState: true });
		else if (alreadySetUp) void goto(unlock, { replaceState: true });
	});

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!ready) return;
		working = true;
		failure = null;
		try {
			const { recoveryPhrase } = await createAccount(passphrase);
			onboarding.recoveryPhrase = recoveryPhrase;
			passphrase = '';
			confirmation = '';
			await goto(resolve('/setup/recovery'));
			// Health was read before the account existed; the screens after this
			// one decide from it, so tell them without another round trip.
			archive.health = { status: 'ok', setup: true };
		} catch (e) {
			if (e instanceof AlreadySetUpError) {
				await archive.refresh();
				return;
			}
			if (e instanceof SetupUnfinishedError) failure = 'unfinished';
			else if (e instanceof ServerUnreachableError) failure = 'unreachable';
			else failure = 'unknown';
		} finally {
			working = false;
		}
	}
</script>

<svelte:head><title>Create account · mailarchive</title></svelte:head>

<Step step={1} title="Create account">
	{#snippet lead()}
		One archive, one account. Your passphrase encrypts everything; the server never sees it.
	{/snippet}
	<form onsubmit={submit}>
		<PassphraseField
			bind:value={passphrase}
			name="passphrase"
			disabled={working || alreadySetUp}
			error={tooWeak ? 'Too short to be safe' : null}
		/>
		<Field
			label="Confirm passphrase"
			type="password"
			name="confirmation"
			placeholder="Type it again"
			autocomplete="new-password"
			bind:value={confirmation}
			disabled={working || alreadySetUp}
			error={mismatch ? 'The passphrases differ' : null}
		/>
		<div class="actions">
			<span class="aside">
				{working ? 'Deriving keys…' : 'Deriving keys takes a few seconds'}
			</span>
			<Button type="submit" busy={working} disabled={!ready}>Continue</Button>
		</div>
	</form>
	{#snippet notice()}
		{#if failure === 'unfinished'}
			<Notice tone="accent" label="created">
				The account exists but could not be opened. <a href={resolve('/unlock')}>Unlock</a> with your
				passphrase, then generate a recovery key from Settings.
			</Notice>
		{:else if failure === 'unreachable'}
			<Notice>The server cannot be reached — try again</Notice>
		{:else if failure === 'unknown'}
			<Notice>Something went wrong — try again</Notice>
		{/if}
	{/snippet}
</Step>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
	}

	.aside {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}
</style>
