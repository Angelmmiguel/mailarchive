<!--
  Recovery key, step 2 of onboarding. Shows the phrase produced by Create
  account once; Continue needs the confirmation and forgets the phrase.
  After a reload the phrase is gone: the account is fine, and a new key can
  be generated from Settings, which is what the screen then says.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Checkbox, Notice, RecoveryKeyPanel, Step } from '$lib/components';
	import { onboarding } from '$lib/state/onboarding.svelte';
	import { session } from '$lib/state/session.svelte';

	let stored = $state(false);
	const phrase = $derived(onboarding.recoveryPhrase);

	$effect(() => {
		if (phrase === null && session.status === 'locked') void goto(resolve('/'));
	});

	async function next(): Promise<void> {
		onboarding.takeRecoveryPhrase();
		await goto(resolve('/setup/addresses'));
	}
</script>

<svelte:head><title>Recovery key · mailarchive</title></svelte:head>

<Step step={2} title="Recovery key" width="wide">
	{#snippet lead()}
		Shown once. If you lose both your passphrase and this key, the archive cannot be opened by
		anyone, including us.
	{/snippet}
	{#if phrase !== null}
		<RecoveryKeyPanel {phrase} />
		<Checkbox bind:checked={stored} name="stored">
			I have stored this key somewhere safe, outside this device.
		</Checkbox>
		<div class="actions">
			<Button onclick={next} disabled={!stored}>Continue</Button>
		</div>
	{:else if session.status === 'unlocked'}
		<div class="actions">
			<Button onclick={next}>Continue</Button>
		</div>
	{/if}
	{#snippet notice()}
		{#if phrase === null && session.status === 'unlocked'}
			<Notice tone="accent" label="notice">
				The key was already shown and cannot be shown again. Generate a new one from Settings.
			</Notice>
		{/if}
	{/snippet}
</Step>

<style>
	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
