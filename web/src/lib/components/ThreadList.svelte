<!--
  The list of threads: the chips that edit the query, the count, the rows.
  Only the rows near the viewport are in the document, so a listing of
  thousands opens and scrolls as one of ten would, and the arrow keys (or j and
  k) move the selection from anywhere on the screen that is not a text
  field. Nothing found is a state of its own, with the way out of it.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';
	import { count } from '$lib/app/format';
	import { participantsOf, type Thread } from '$lib/index/threads';
	import { presetOf, presets, rangeLabel } from '$lib/search/dates';
	import { hasWords, isEmpty, parseQuery, setOperator, withoutDates } from '$lib/search/query';
	import type { Order } from '$lib/search/search';
	import type { IndexProgress } from '$lib/state/index.svelte';
	import Button from './Button.svelte';
	import Chip from './Chip.svelte';
	import ChipMenu, { type Item } from './ChipMenu.svelte';
	import ThreadRow from './ThreadRow.svelte';

	interface Props {
		threads: Thread[];
		/** The thread the reader shows, if any. */
		selected?: string | null;
		own: string[];
		query: string;
		order: Order;
		/** Years with messages, for the date chip. */
		years: number[];
		/** Shards still arriving: body search covers only part of the archive. */
		indexing?: IndexProgress | null;
		hrefFor: (thread: Thread) => ResolvedPathname;
		onquery: (query: string) => void;
		onorder: (order: Order) => void;
		onopen: (thread: Thread) => void;
		banner?: Snippet;
	}

	let {
		threads,
		selected = null,
		own,
		query,
		order,
		years,
		indexing = null,
		hrefFor,
		onquery,
		onorder,
		onopen,
		banner
	}: Props = $props();

	// Every row is this tall, which is what lets the list place them by index.
	const ROW = 56;
	// Rows kept beyond each edge of the viewport, so a flick has something to show.
	const OVERSCAN = 10;
	let list = $state<HTMLElement | null>(null);
	let scrollTop = $state(0);
	let height = $state(0);
	const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
	const end = $derived(Math.min(threads.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
	const shown = $derived(threads.slice(start, end));

	const parsed = $derived(parseQuery(query));
	const ranges = $derived(presets(years));
	const range = $derived(rangeLabel(parsed, ranges));
	const preset = $derived(presetOf(parsed, ranges));
	const ranked = $derived(hasWords(parsed));
	const dateItems = $derived.by((): Item[] => {
		const items: Item[] = ranges.map((p) => ({
			id: `range:${p.id}`,
			label: p.label,
			checked: preset?.id === p.id,
			group: 'Range'
		}));
		if (ranked) {
			items.push({
				id: 'order:best',
				label: 'Best match',
				checked: order === 'best',
				group: 'Order'
			});
		}
		items.push(
			{
				id: 'order:newest',
				label: 'Newest first',
				checked: order === 'newest' || (order === 'best' && !ranked),
				group: 'Order'
			},
			{ id: 'order:oldest', label: 'Oldest first', checked: order === 'oldest', group: 'Order' }
		);
		return items;
	});

	function pickDate(id: string): void {
		if (id.startsWith('order:')) {
			onorder(id.slice('order:'.length) as Order);
			return;
		}
		const chosen = ranges.find((p) => `range:${p.id}` === id);
		if (chosen === undefined) return;
		onquery(setOperator(setOperator(query, 'after', chosen.after), 'before', chosen.before));
	}

	const between = $derived.by((): string | null => {
		const after = parsed.after?.text;
		const before = parsed.before?.text;
		if (after !== undefined && before !== undefined) return `between ${after} and ${before}`;
		if (after !== undefined) return `since ${after}`;
		if (before !== undefined) return `before ${before}`;
		return null;
	});
	const rest = $derived(withoutDates(query).trim());
	// Spaces live in the expressions: the template trims them at block edges.
	const lead = $derived(rest === '' ? 'Nothing ' : 'Nothing matches ');
	const tail = $derived(between === null ? '.' : ` ${between}.`);

	function scrolled(): void {
		if (list !== null) scrollTop = list.scrollTop;
	}

	// A new selection, or a new listing around it, may put the open thread
	// anywhere, rendered or not: the nearest edge of the viewport moves to
	// its row. Scrolling is not tracked here, so it never pulls the list back.
	$effect(() => {
		if (selected === null || list === null || height === 0) return;
		const at = threads.findIndex((t) => t.id === selected);
		if (at === -1) return;
		const top = at * ROW;
		const seen = untrack(() => scrollTop);
		if (top < seen) list.scrollTop = top;
		else if (top + ROW > seen + height) list.scrollTop = top + ROW - height;
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
		<Chip
			active={parsed.sent}
			onclick={() => onquery(setOperator(query, 'is', parsed.sent ? null : 'sent'))}>sent</Chip
		>
		<Chip
			active={parsed.attachments}
			onclick={() => onquery(setOperator(query, 'has', parsed.attachments ? null : 'attachment'))}
			>attachments</Chip
		>
		<ChipMenu
			label={range ?? 'date'}
			active={range !== null || order !== 'best'}
			items={dateItems}
			onselect={pickDate}
		/>
		<span class="count">
			{count(threads.length, 'thread')}{#if indexing !== null}
				<span class="indexing" role="status">· indexing {indexing.done}/{indexing.total}</span>{/if}
		</span>
	</div>
	<div class="rows" bind:this={list} bind:clientHeight={height} onscroll={scrolled}>
		{#if threads.length > 0}
			<div class="canvas" style:height="{threads.length * ROW}px">
				<div class="window" style:transform="translateY({start * ROW}px)">
					{#each shown as thread (thread.id)}
						<ThreadRow
							{thread}
							participants={participantsOf(thread, own)}
							href={hrefFor(thread)}
							selected={thread.id === selected}
						/>
					{/each}
				</div>
			</div>
		{:else if isEmpty(parsed)}
			<p class="none">No threads yet.</p>
		{:else}
			<section class="empty" aria-labelledby="no-results">
				<h2 id="no-results">No results</h2>
				<p>
					{lead}{#if rest !== ''}<code>{rest}</code>{/if}{tail}
				</p>
				<div class="actions">
					{#if between !== null}
						<Button variant="secondary" size="sm" onclick={() => onquery(withoutDates(query))}
							>Clear date range</Button
						>
					{/if}
					<Button variant="secondary" size="sm" onclick={() => onquery('')}>Clear all</Button>
				</div>
			</section>
		{/if}
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
		white-space: nowrap;
	}

	.indexing {
		margin-left: 4px;
	}

	.rows {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.canvas {
		position: relative;
		overflow: hidden;
	}

	.window {
		position: absolute;
		inset: 0 0 auto;
	}

	.none {
		margin: 0;
		padding: var(--space-6) var(--space-4);
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}

	.empty {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-7) var(--space-5);
	}

	h2 {
		margin: 0;
		font: 600 var(--body-lg) / 1.3 var(--font-body);
	}

	.empty p {
		margin: 0;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	code {
		padding: 1px 5px;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		font: var(--mono-md) var(--font-mono);
		color: var(--text-body);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
