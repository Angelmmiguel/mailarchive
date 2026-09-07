<!--
  The archive. Health decides where a visitor belongs: no account goes to
  Create account, a locked archive to Unlock. What remains is the reading
  view, which for now knows the empty state and the count; the list
  arrives with search.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Code, EmptyState } from '$lib/components';
	import { archive } from '$lib/state/archive.svelte';
	import { importState } from '$lib/state/import.svelte';
	import { index } from '$lib/state/index.svelte';
	import { session } from '$lib/state/session.svelte';

	const messages = $derived(index.messages);

	$effect(() => {
		if (session.status === 'unlocked' || archive.health === null) return;
		if (!archive.health.setup) void goto(resolve('/setup'), { replaceState: true });
		else void goto(resolve('/unlock'), { replaceState: true });
	});
</script>

<svelte:head><title>Archive · mailarchive</title></svelte:head>

{#if session.status === 'unlocked'}
	{#if index.loading !== null}
		<p class="status">Decrypting index…</p>
	{:else if messages === 0}
		<EmptyState eyebrow="0 messages" title="The archive is empty">
			Import <Code>.eml</Code> files from a folder or drop them anywhere on this page. Everything is encrypted
			before it leaves this device.
			{#snippet actions()}
				<Button onclick={() => (importState.panelOpen = true)}>Import messages</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState
			eyebrow="{messages.toLocaleString()} {messages === 1 ? 'message' : 'messages'}"
			title="The archive is ready"
		>
			The list of threads arrives with search. Drop more <Code>.eml</Code> files anywhere on this page
			to keep importing.
			{#snippet actions()}
				<Button variant="secondary" onclick={() => (importState.panelOpen = true)}
					>Import more</Button
				>
			{/snippet}
		</EmptyState>
	{/if}
{:else if archive.error !== null}
	<p class="status">The archive is unreachable.</p>
{:else}
	<p class="status">Loading…</p>
{/if}

<style>
	.status {
		margin: auto;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}
</style>
