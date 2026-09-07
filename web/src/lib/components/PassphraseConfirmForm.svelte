<!--
  Asks for the current passphrase before something the session cookie alone
  must not be able to do. The verdict on it arrives through `error`.
-->
<script lang="ts">
	import Button from './Button.svelte';
	import Field from './Field.svelte';

	interface Props {
		/** The submit button's label. */
		label: string;
		busy?: boolean;
		error?: string | null;
		onsubmit: (passphrase: string) => Promise<void>;
		oncancel: () => void;
	}

	let { label, busy = false, error = null, onsubmit, oncancel }: Props = $props();

	let passphrase = $state('');
	let form = $state<HTMLFormElement | null>(null);

	$effect(() => {
		form?.querySelector('input')?.focus();
	});

	const ready = $derived(passphrase !== '' && !busy);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!ready) return;
		await onsubmit(passphrase);
		passphrase = '';
	}
</script>

<form class="form" bind:this={form} onsubmit={submit} aria-label={label}>
	<Field
		label="Current passphrase"
		type="password"
		name="current"
		autocomplete="current-password"
		bind:value={passphrase}
		disabled={busy}
		{error}
	/>
	<div class="actions">
		<Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>Cancel</Button>
		<Button type="submit" size="sm" {busy} disabled={!ready}>{label}</Button>
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
