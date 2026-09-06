<!--
  The shell: the wordmark, the warnings that apply everywhere and the
  screen. The parts that appear after unlock (search, import, settings,
  lock) arrive with the archive views.
-->
<script lang="ts">
	import '$lib/styles/app.css';
	import { Banner } from '$lib/components';
	import { isInsecureContext } from '$lib/crypto/random';
	import { archive } from '$lib/state/archive.svelte';

	let { children } = $props();
	const insecure = isInsecureContext();
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
	<header class="brand">ARCHIVE</header>
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
