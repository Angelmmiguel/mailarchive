<!--
  The shell: the wordmark, the warnings that apply everywhere and the
  screen. After unlock the wordmark grows into the toolbar with search,
  Import, Settings and Lock, the import panel and the whole page as a drop
  target come with it, and toasts report what finished.
-->
<script lang="ts">
	import '$lib/styles/app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { lock } from '$lib/account/unlock';
	import { unlockUrl } from '$lib/app/navigation';
	import { cancelImport, startImport } from '$lib/import/start';
	import type { ImportFile } from '$lib/import/sources';
	import { Banner, DropOverlay, ImportPanel, SearchField, Toasts, Toolbar } from '$lib/components';
	import { isInsecureContext } from '$lib/crypto/random';
	import { archive } from '$lib/state/archive.svelte';
	import { importState } from '$lib/state/import.svelte';
	import { session } from '$lib/state/session.svelte';

	let { children } = $props();
	const insecure = isInsecureContext();
	let query = $state('');
	const unlocked = $derived(session.status === 'unlocked');

	async function lockArchive(): Promise<void> {
		// A running import commits what it finished before the keys go.
		await cancelImport();
		await leave();
	}

	async function leave(reason?: 'expired'): Promise<void> {
		const from = page.url.pathname + page.url.search;
		await lock();
		await goto(unlockUrl(from, reason));
	}

	function importFiles(files: ImportFile[]): void {
		void startImport(files, { onexpired: () => void leave('expired') });
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
	{#if unlocked}
		<Toolbar
			onlock={lockArchive}
			onimport={() => (importState.panelOpen = !importState.panelOpen)}
			importing={importState.active ? importState.percent : null}
		>
			{#snippet search()}
				<SearchField bind:value={query} disabled />
			{/snippet}
		</Toolbar>
	{:else}
		<header class="brand">ARCHIVE</header>
	{/if}
	<main>{@render children()}</main>
</div>
{#if unlocked}
	<DropOverlay onfiles={importFiles} />
	{#if importState.panelOpen}
		<ImportPanel
			onfiles={importFiles}
			oncancel={cancelImport}
			onclose={() => (importState.panelOpen = false)}
			onreset={() => importState.reset()}
		/>
	{/if}
{/if}
<Toasts />

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
