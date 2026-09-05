<script lang="ts">
	import { onMount } from 'svelte';
	import { archive } from '$lib/state/archive.svelte';

	// Scaffolding: the one screen that exists proves the whole path works, in
	// development through the Vite proxy and in production from the Go binary.
	onMount(() => {
		void archive.refresh();
	});
</script>

<h1>mailarchive</h1>

{#if archive.error !== null}
	<p>The archive is unreachable: {archive.error}</p>
{:else if archive.health === null}
	<p>Loading…</p>
{:else if archive.health.setup}
	<p>Archive is ready</p>
{:else}
	<p>Archive is not set up</p>
{/if}
