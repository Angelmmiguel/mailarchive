<!--
  The list of threads: the filter chips, the count, the rows. Rows come
  in pages as the list is scrolled, and the arrow keys (or j and k) move
  the selection from anywhere on the screen that is not a text field.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';
	import { count } from '$lib/app/format';
	import { participantsOf, type Filters, type Thread } from '$lib/index/threads';
	import Chip from './Chip.svelte';
	import ThreadRow from './ThreadRow.svelte';

	interface Props {
		threads: Thread[];
		/** The thread the reader shows, if any. */
		selected?: string | null;
		own: string[];
		filters: Filters;
		hrefFor: (thread: Thread) => ResolvedPathname;
		onfilters: (filters: Filters) => void;
		onopen: (thread: Thread) => void;
		banner?: Snippet;
	}

	let {
		threads,
		selected = null,
		own,
		filters,
		hrefFor,
		onfilters,
		onopen,
		banner
	}: Props = $props();

	const PAGE = 100;
	let limit = $state(PAGE);
	let list = $state<HTMLElement | null>(null);
	const shown = $derived(threads.slice(0, limit));
	const filtered = $derived(filters.sent || filters.attachments);

	function scrolled(): void {
		if (list === null || limit >= threads.length) return;
		if (list.scrollTop + list.clientHeight > list.scrollHeight - 800) limit += PAGE;
	}

	// A new selection may sit below the fold, or beyond the loaded page.
	$effect(() => {
		if (selected === null || list === null) return;
		const at = threads.findIndex((t) => t.id === selected);
		if (at >= limit) limit = at + PAGE;
		queueMicrotask(() => {
			list?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
		});
	});

	function keydown(event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
		) {
			return;
		}
		const step =
			event.key === 'ArrowDown' || event.key === 'j'
				? 1
				: event.key === 'ArrowUp' || event.key === 'k'
					? -1
					: 0;
		if (step === 0 || threads.length === 0) return;
		event.preventDefault();
		const at = threads.findIndex((t) => t.id === selected);
		const next = at === -1 ? (step > 0 ? 0 : threads.length - 1) : at + step;
		if (next >= 0 && next < threads.length) onopen(threads[next]);
	}
</script>

<svelte:window onkeydown={keydown} />

<section class="threads" aria-label="Threads">
	{#if banner}{@render banner()}{/if}
	<div class="filters">
		<Chip active={filters.sent} onclick={() => onfilters({ ...filters, sent: !filters.sent })}
			>sent</Chip
		>
		<Chip
			active={filters.attachments}
			onclick={() => onfilters({ ...filters, attachments: !filters.attachments })}>attachments</Chip
		>
		<span class="count">{count(threads.length, 'thread')}</span>
	</div>
	<div class="rows" bind:this={list} onscroll={scrolled}>
		{#each shown as thread (thread.id)}
			<ThreadRow
				{thread}
				participants={participantsOf(thread, own)}
				href={hrefFor(thread)}
				selected={thread.id === selected}
			/>
		{:else}
			<p class="none">
				{filtered ? 'No threads match these filters.' : 'No threads yet.'}
			</p>
		{/each}
	</div>
</section>

<style>
	.threads {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: var(--hairline);
	}

	.filters {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 44px;
		padding: 0 var(--space-4);
		border-bottom: var(--hairline);
		flex: none;
	}

	.count {
		margin-left: auto;
		font: var(--mono-sm) var(--font-mono);
		color: var(--text-faint);
	}

	.rows {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.none {
		margin: 0;
		padding: var(--space-6) var(--space-4);
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}
</style>
