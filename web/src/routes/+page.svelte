<!--
  The archive. Health decides where a visitor belongs: no account goes to
  Create account, a locked archive to Unlock. What remains is the reading
  view, which for now knows only the empty state; the list arrives with the
  index.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button, Code, EmptyState } from '$lib/components';
	import { archive } from '$lib/state/archive.svelte';
	import { session } from '$lib/state/session.svelte';

	const messages = $derived(
		session.manifest?.body.segments.reduce((sum, s) => sum + s.messages, 0) ?? 0
	);

	$effect(() => {
		if (session.status === 'unlocked' || archive.health === null) return;
		if (!archive.health.setup) void goto(resolve('/setup'), { replaceState: true });
		else void goto(resolve('/unlock'), { replaceState: true });
	});
</script>

<svelte:head><title>Archive · mailarchive</title></svelte:head>

{#if session.status === 'unlocked'}
	{#if messages === 0}
		<EmptyState eyebrow="0 messages" title="The archive is empty">
			Import <Code>.eml</Code> files from a folder or drop them anywhere on this page. Everything is encrypted
			before it leaves this device.
			{#snippet actions()}
				<Button disabled>Import messages</Button>
				<span class="aside">Import is not available yet</span>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState eyebrow="{messages.toLocaleString()} messages" title="The archive is ready">
			The list of threads arrives with the index.
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

	.aside {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}
</style>
