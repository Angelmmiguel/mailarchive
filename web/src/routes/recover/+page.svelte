<!-- Placeholder until the Recover screen is built; Unlock links here. -->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Step } from '$lib/components';
</script>

<svelte:head><title>Recover access · mailarchive</title></svelte:head>

<Step step={1} total={2} title="Recover access" width="wide">
	{#snippet lead()}This screen is not built yet.{/snippet}
	<p class="back"><a href={resolve('/unlock')}>Back to Unlock</a></p>
</Step>

<style>
	.back {
		margin: 0;
		font: var(--mono-sm) / 1 var(--font-mono);
	}
</style>
