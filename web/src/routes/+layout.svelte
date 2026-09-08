<!--
  The shell: the wordmark, the warnings that apply everywhere and the
  screen. After unlock the wordmark grows into the toolbar with search,
  Import, Settings and Lock, the import panel and the whole page as a drop
  target come with it, and toasts report what finished. The search box
  edits the shared query directly, so the chips see every keystroke; the
  URL follows a moment after typing stops, and a change of the URL from
  elsewhere (back, a link) resets the query.
-->
<script lang="ts">
	import '$lib/styles/app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { followLocks, leave, lockArchive } from '$lib/app/lock';
	import { archiveSearch } from '$lib/app/navigation';
	import { cancelImport, startImport } from '$lib/import/start';
	import type { ImportFile } from '$lib/import/sources';
	import { Banner, DropOverlay, ImportPanel, SearchField, Toasts, Toolbar } from '$lib/components';
	import { isInsecureContext } from '$lib/crypto/random';
	import { archive } from '$lib/state/archive.svelte';
	import { importState } from '$lib/state/import.svelte';
	import { index } from '$lib/state/index.svelte';
	import { session } from '$lib/state/session.svelte';
	import { view } from '$lib/state/view.svelte';
	import { parseOrder } from '$lib/search/search';

	let { children } = $props();
	const insecure = isInsecureContext();
	const unlocked = $derived(session.status === 'unlocked');
	const SEARCH_DELAY = 150;

	// What the URL last said; a change there (back, a chip, a link) resets
	// the query, while the query's own pushes are recognised and left alone.
	let seen = '';
	$effect(() => {
		const q = page.url.searchParams.get('q') ?? '';
		view.order = parseOrder(page.url.searchParams.get('order'));
		if (q === seen) return;
		seen = q;
		view.query = q;
	});

	$effect(() => {
		const typed = view.query;
		if (typed.trim() === seen.trim() || !unlocked) return;
		const timer = setTimeout(() => {
			seen = typed.trim();
			const onArchive = page.route.id?.startsWith('/(archive)') === true;
			const path = onArchive ? page.url.pathname : '/';
			void goto(`${path}${archiveSearch(typed, view.order)}` as ResolvedPathname, {
				replaceState: onArchive,
				keepFocus: true
			});
		}, SEARCH_DELAY);
		return () => clearTimeout(timer);
	});

	const here = $derived(page.url.pathname + page.url.search);

	// A lock in another tab is this one's too.
	$effect(() => followLocks(() => here));

	function importFiles(files: ImportFile[]): void {
		void startImport(files, { onexpired: () => void leave(here, 'expired') });
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
			onlock={() => lockArchive(here)}
			onimport={() => (importState.panelOpen = !importState.panelOpen)}
			onsettings={() => {
				if (page.route.id !== '/settings') void goto(resolve('/settings'));
			}}
			settingsOpen={page.route.id === '/settings'}
			importing={importState.active ? importState.percent : null}
		>
			{#snippet search()}
				<SearchField bind:value={view.query} disabled={index.messages === 0} />
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
	/* The viewport, so that the archive's panes scroll on their own. */
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	.brand {
		padding: 20px var(--space-5);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
	}

	main {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 0 var(--space-5);
		overflow-y: auto;
	}
</style>
