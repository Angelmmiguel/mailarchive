<!--
  Own addresses, step 3 of onboarding. Edits the list held in the manifest
  and saves it through the account layer; Skip leaves the manifest as it is.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ServerUnreachableError, SessionExpiredError } from '$lib/account/errors';
	import { saveSettings } from '$lib/account/settings';
	import { AddressList, Button, Code, Notice, Step } from '$lib/components';
	import { session } from '$lib/state/session.svelte';

	let addresses = $state<string[]>([...(session.manifest?.body.settings.ownAddresses ?? [])]);
	let working = $state(false);
	let failure = $state<'unreachable' | 'expired' | 'unknown' | null>(null);
	let list = $state<AddressList | null>(null);

	$effect(() => {
		if (session.status === 'locked') void goto(resolve('/'));
	});

	async function save(): Promise<void> {
		// An address typed but not yet added is one the user meant to keep. An
		// invalid draft is reported by the list itself and stops the save.
		if (list !== null && !list.add() && list.hasDraft()) return;
		working = true;
		failure = null;
		try {
			await saveSettings({ ownAddresses: addresses });
			await goto(resolve('/'));
		} catch (e) {
			if (e instanceof ServerUnreachableError) failure = 'unreachable';
			else if (e instanceof SessionExpiredError) failure = 'expired';
			else failure = 'unknown';
		} finally {
			working = false;
		}
	}
</script>

<svelte:head><title>Your addresses · mailarchive</title></svelte:head>

<Step step={3} title="Your addresses" width="wide">
	{#snippet lead()}
		Mail from these addresses is labelled <Code>sent</Code> and lists show “to X” instead of your own
		name.
	{/snippet}
	<AddressList bind:this={list} bind:addresses disabled={working} />
	<div class="actions">
		<Button variant="ghost" onclick={() => goto(resolve('/'))} disabled={working}>
			Skip for now
		</Button>
		<Button onclick={save} busy={working}>Open archive</Button>
	</div>
	{#snippet notice()}
		{#if failure === 'unreachable'}
			<Notice>The server cannot be reached — try again</Notice>
		{:else if failure === 'expired'}
			<Notice>
				The session has expired — <a href={resolve('/unlock')}>unlock</a> and add the addresses from Settings
			</Notice>
		{:else if failure === 'unknown'}
			<Notice>Something went wrong — try again</Notice>
		{/if}
	{/snippet}
</Step>

<style>
	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
</style>
