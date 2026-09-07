<!--
  The current passphrase, the new one with its strength and a confirmation.
  The form owns what can be judged locally (length, mismatch); the account
  layer's verdict on the current passphrase arrives through `error`.
-->
<script lang="ts">
	import { passphraseStrength } from '$lib/account/strength';
	import { MAX_PASSPHRASE } from '$lib/crypto/kdf';
	import Button from './Button.svelte';
	import Field from './Field.svelte';
	import PassphraseField from './PassphraseField.svelte';

	interface Props {
		busy?: boolean;
		/** Why the current passphrase was refused, from the account layer. */
		error?: string | null;
		onsubmit: (current: string, next: string) => Promise<void>;
		oncancel: () => void;
	}

	let { busy = false, error = null, onsubmit, oncancel }: Props = $props();

	let current = $state('');
	let next = $state('');
	let confirmation = $state('');
	let form = $state<HTMLFormElement | null>(null);

	// The form opens on demand, so the first field takes the focus.
	$effect(() => {
		form?.querySelector('input')?.focus();
	});

	const tooWeak = $derived(next !== '' && passphraseStrength(next).score === 0);
	const tooLong = $derived(passphraseStrength(next).characters > MAX_PASSPHRASE);
	const mismatch = $derived(confirmation !== '' && confirmation !== next);
	const same = $derived(next !== '' && next === current);
	const ready = $derived(
		current !== '' && next !== '' && !tooWeak && !tooLong && !same && confirmation === next && !busy
	);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!ready) return;
		await onsubmit(current, next);
		// The fields are wiped either way; a refused attempt starts over.
		current = '';
		next = '';
		confirmation = '';
	}
</script>

<form class="form" bind:this={form} onsubmit={submit} aria-label="Change passphrase">
	<Field
		label="Current passphrase"
		type="password"
		name="current"
		autocomplete="current-password"
		bind:value={current}
		disabled={busy}
		{error}
	/>
	<PassphraseField
		label="New passphrase"
		name="next"
		bind:value={next}
		disabled={busy}
		error={same
			? 'The new passphrase is the current one'
			: tooLong
				? `At most ${MAX_PASSPHRASE} characters`
				: null}
	/>
	<Field
		label="Confirm new passphrase"
		type="password"
		name="confirmation"
		autocomplete="new-password"
		bind:value={confirmation}
		disabled={busy}
		error={mismatch ? 'The passphrases differ' : null}
	/>
	<div class="actions">
		<Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>Cancel</Button>
		<Button type="submit" size="sm" {busy} disabled={!ready}>
			{busy ? 'Changing' : 'Change passphrase'}
		</Button>
	</div>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
