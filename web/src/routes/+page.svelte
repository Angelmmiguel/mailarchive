<!--
  The archive. Until the reading views land this only routes: a server with
  no account goes to onboarding, everything else sees where it stands.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { archive } from '$lib/state/archive.svelte';
	import { session } from '$lib/state/session.svelte';

	$effect(() => {
		if (archive.health !== null && !archive.health.setup) void goto(resolve('/setup'));
	});
</script>

<section class="placeholder">
	{#if archive.error !== null}
		<p>The archive is unreachable.</p>
	{:else if archive.health === null}
		<p>Loading…</p>
	{:else if session.status === 'unlocked'}
		<h1>Archive</h1>
		<p data-testid="archive-status">
			{#if session.manifest?.body.segments.length === 0}
				The archive is empty. Import will land here.
			{:else}
				The archive is ready.
			{/if}
		</p>
	{:else if archive.health.setup}
		<p>The archive is locked. <a href={resolve('/unlock')}>Unlock</a></p>
	{/if}
</section>

<style>
	.placeholder {
		margin: auto;
		max-width: 440px;
		width: 100%;
		color: var(--text-muted);
	}

	h1 {
		margin: 0 0 var(--space-2);
		font: 500 var(--mono-2xl) / 1.2 var(--font-mono);
		color: var(--text-body);
	}
</style>
