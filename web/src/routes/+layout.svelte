<!--
  The shell: the wordmark, the warnings that apply everywhere and the
  screen. After unlock the wordmark grows into the toolbar with search,
  Import, Settings and Lock; Lock returns to Unlock, which comes back here.
-->
<script lang="ts">
	import '$lib/styles/app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { lock } from '$lib/account/unlock';
	import { unlockUrl } from '$lib/app/navigation';
	import { Banner, SearchField, Toolbar } from '$lib/components';
	import { isInsecureContext } from '$lib/crypto/random';
	import { archive } from '$lib/state/archive.svelte';
	import { session } from '$lib/state/session.svelte';

	let { children } = $props();
	const insecure = isInsecureContext();
	let query = $state('');

	async function lockArchive(): Promise<void> {
		const from = page.url.pathname + page.url.search;
		await lock();
		await goto(unlockUrl(from));
	}
</script>

{#if insecure}
	<Banner>
		This page is not served over HTTPS. Keys derived here can be read on the way; use a secure
		connection before creating or unlocking an archive.
	</Banner>
{/if}
{#if archive.error !== null}
	<Banner>The server cannot be reached. Retrying when you continue.</Banner>
{/if}
<div class="shell">
	{#if session.status === 'unlocked'}
		<Toolbar onlock={lockArchive}>
			{#snippet search()}
				<SearchField bind:value={query} disabled />
			{/snippet}
		</Toolbar>
	{:else}
		<header class="brand">ARCHIVE</header>
	{/if}
	<main>{@render children()}</main>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	.brand {
		padding: 20px var(--space-5);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
	}

	main {
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 0 var(--space-5);
	}
</style>
