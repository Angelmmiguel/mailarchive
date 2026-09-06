<!--
  Placeholder until the Unlock screen is built. Create account already sends
  a server that has its account here, with the reason in the URL so that the
  message survives a reload.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Banner, Step } from '$lib/components';

	const reason = $derived(page.url.searchParams.get('reason'));
</script>

<svelte:head><title>Unlock · mailarchive</title></svelte:head>

{#if reason === 'already-set-up'}
	<Banner tone="accent">
		This archive is already set up. Unlock it with your passphrase to continue.
	</Banner>
{/if}
<Step step={1} total={1} title="Unlock">
	{#snippet lead()}This screen is not built yet.{/snippet}
	<p></p>
</Step>
