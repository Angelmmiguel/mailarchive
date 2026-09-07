<!--
  The archive. Health decides where a visitor belongs: no account goes to
  Create account, a locked archive to Unlock. What remains is the list of
  threads with, beside it, whatever the address names: the reader for a
  thread, or the prompt to pick one. The shell keeps the query and the
  URL in step; the chips here write the URL straight away, with what the
  box holds at that moment. Every so often the
  manifest is checked for segments another device wrote.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import { checkForSegments, SYNC_INTERVAL } from '$lib/account/sync';
	import { openArchive } from '$lib/app/boot';
	import { archiveSearch } from '$lib/app/navigation';
	import { count } from '$lib/app/format';
	import { Button, Code, EmptyState, Strip, ThreadList } from '$lib/components';
	import type { Thread } from '$lib/index/threads';
	import type { Order } from '$lib/search/search';
	import { archive } from '$lib/state/archive.svelte';
	import { importState } from '$lib/state/import.svelte';
	import { index } from '$lib/state/index.svelte';
	import { session } from '$lib/state/session.svelte';
	import { terms } from '$lib/state/terms.svelte';
	import { view } from '$lib/state/view.svelte';

	let { children } = $props();

	const unlocked = $derived(session.status === 'unlocked');
	const own = $derived(session.manifest?.body.settings.ownAddresses ?? []);
	const selected = $derived.by(() => {
		const key = page.params.key;
		return key === undefined ? null : (view.threadFor(key)?.id ?? null);
	});
	let reloading = $state(false);

	$effect(() => {
		if (unlocked || archive.health === null) return;
		if (!archive.health.setup) void goto(resolve('/setup'), { replaceState: true });
		else void goto(resolve('/unlock'), { replaceState: true });
	});

	// `ResolvedPathname` does not model a query string, hence the casts.
	function hrefFor(thread: Thread): ResolvedPathname {
		const path = resolve('/(archive)/t/[key]', { key: view.keyFor(thread.id) });
		return `${path}${page.url.search}` as ResolvedPathname;
	}

	function setQuery(query: string): void {
		view.query = query;
		void goto(`${page.url.pathname}${archiveSearch(query, view.order)}` as ResolvedPathname, {
			replaceState: true,
			keepFocus: true
		});
	}

	function setOrder(order: Order): void {
		view.order = order;
		void goto(`${page.url.pathname}${archiveSearch(view.query, order)}` as ResolvedPathname, {
			replaceState: true,
			keepFocus: true
		});
	}

	function open(thread: Thread): void {
		void goto(hrefFor(thread), { keepFocus: true });
	}

	async function reload(): Promise<void> {
		reloading = true;
		try {
			await openArchive();
		} finally {
			reloading = false;
		}
	}

	$effect(() => {
		if (!unlocked) return;
		const check = (): void => {
			if (document.visibilityState === 'visible') void checkForSegments().catch(() => {});
		};
		const timer = setInterval(check, SYNC_INTERVAL);
		document.addEventListener('visibilitychange', check);
		window.addEventListener('focus', check);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', check);
			window.removeEventListener('focus', check);
		};
	});
</script>

<svelte:head><title>Archive · mailarchive</title></svelte:head>

{#if unlocked}
	{#if index.loading !== null}
		<p class="status">Decrypting index…</p>
	{:else if index.messages === 0}
		<EmptyState eyebrow="0 messages" title="The archive is empty">
			Import <Code>.eml</Code> files from a folder or drop them anywhere on this page. Everything is encrypted
			before it leaves this device.
			{#snippet actions()}
				<Button onclick={() => (importState.panelOpen = true)}>Import messages</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="archive" class:reading={page.params.key !== undefined}>
			<ThreadList
				threads={view.listing}
				{selected}
				{own}
				query={view.query}
				order={view.order}
				years={view.years}
				indexing={terms.loading}
				{hrefFor}
				onquery={setQuery}
				onorder={setOrder}
				onopen={open}
			>
				{#snippet banner()}
					{#if view.pendingSegments > 0}
						<Strip action="Reload" busy={reloading} onaction={reload}>
							Another device added {count(view.pendingSegments, 'segment')} since unlock
						</Strip>
					{/if}
				{/snippet}
			</ThreadList>
			<div class="pane">{@render children()}</div>
		</div>
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

	/* Full bleed inside the shell's padded main. */
	.archive {
		flex: 1;
		min-height: 0;
		margin: 0 calc(-1 * var(--space-5));
		display: grid;
		grid-template-columns: minmax(360px, 560px) minmax(0, 1fr);
	}

	.pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}

	@media (max-width: 959px) {
		.archive {
			grid-template-columns: minmax(0, 1fr);
		}

		.archive.reading > :global(.threads),
		.archive:not(.reading) > .pane {
			display: none;
		}
	}
</style>
