<!--
  One thread: the way back and to the neighbours, the summary, and the
  messages oldest first with only the newest open. Opening a message asks
  the screen for its view; the reader remembers what it got. Images are
  off until asked for, and the answer is forgotten with the thread.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { ResolvedPathname } from '$app/types';
	import { count, dateSpan, shortDate } from '$lib/app/format';
	import type { AttachmentFile } from '$lib/account/messages';
	import type { MessageView } from '$lib/import/prepare';
	import type { IndexRecord } from '$lib/index/records';
	import type { Thread } from '$lib/index/threads';
	import { isOwn } from '$lib/mail/labels';
	import type { AttachmentMeta } from '$lib/mail/message';
	import MessageCard from './MessageCard.svelte';

	interface Props {
		thread: Thread;
		own: string[];
		/** 1-based place in the listing, or null when the filters hide the thread. */
		position: number | null;
		total: number;
		archiveHref: ResolvedPathname;
		prevHref: ResolvedPathname | null;
		nextHref: ResolvedPathname | null;
		onopen: (record: IndexRecord) => Promise<MessageView>;
		ondownload: (record: IndexRecord) => Promise<void>;
		oninline: (record: IndexRecord) => Promise<Map<string, AttachmentFile>>;
		onsource: (record: IndexRecord) => Promise<string>;
		onattachment: (record: IndexRecord, attachment: AttachmentMeta) => Promise<void>;
	}

	let {
		thread,
		own,
		position,
		total,
		archiveHref,
		prevHref,
		nextHref,
		onopen,
		ondownload,
		oninline,
		onsource,
		onattachment
	}: Props = $props();

	interface Opened {
		message: MessageView | null;
		error: string | null;
	}

	// A new thread starts with its newest message open and the rest folded.
	const expanded = $derived(new SvelteSet([thread.latest.id]));
	// Written by the button, reset by the next thread.
	let images = $derived(thread.id === null);
	const opened = new SvelteMap<string, Opened>();

	$effect(() => {
		for (const id of expanded) {
			if (untrack(() => opened.has(id))) continue;
			const record = thread.messages.find((m) => m.id === id);
			if (record === undefined) continue;
			opened.set(id, { message: null, error: null });
			void onopen(record).then(
				(message) => opened.set(id, { message, error: null }),
				(e: unknown) =>
					opened.set(id, { message: null, error: e instanceof Error ? e.message : String(e) })
			);
		}
	});

	function toggle(id: string): void {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}

	function sender(record: IndexRecord): string {
		if (record.from === null) return 'unknown';
		return isOwn(record.from.address, own) ? 'me' : record.from.address;
	}

	const first = $derived(thread.messages[0]);
</script>

<article class="reader" aria-labelledby="thread-title">
	<nav class="bar" aria-label="Thread">
		<a class="back" href={archiveHref}>← Archive</a>
		<button
			type="button"
			class="step images"
			aria-pressed={images}
			onclick={() => (images = !images)}
		>
			{images ? 'Hide images' : 'Load images'}
		</button>
		<span class="place">{position === null ? '–' : position} / {total}</span>
		{#if prevHref === null}
			<span class="step" aria-disabled="true">↑ prev</span>
		{:else}
			<a class="step" href={prevHref}>↑ prev</a>
		{/if}
		{#if nextHref === null}
			<span class="step" aria-disabled="true">↓ next</span>
		{:else}
			<a class="step" href={nextHref}>↓ next</a>
		{/if}
	</nav>
	<div class="scroll">
		<header class="summary">
			<h1 id="thread-title">{thread.subject}</h1>
			<div class="facts">
				<span>{count(thread.messages.length, 'message')}</span>
				{#if thread.latest.date !== null}
					<span>·</span>
					<span>{dateSpan(first.date, thread.latest.date)}</span>
				{/if}
				{#if thread.attachments > 0}
					<span>·</span>
					<span>{count(thread.attachments, 'attachment')}</span>
				{/if}
				{#each thread.labels as label (label)}
					<span class="label">{label}</span>
				{/each}
			</div>
		</header>
		<ol class="messages">
			{#each thread.messages as record (record.id)}
				<li class:open={expanded.has(record.id)}>
					<button
						type="button"
						class="row"
						aria-expanded={expanded.has(record.id)}
						onclick={() => toggle(record.id)}
					>
						<span class="from">{sender(record)}</span>
						<span class="snippet">{expanded.has(record.id) ? record.subject : record.snippet}</span>
						<span class="date"
							>{#if record.attachments.some((a) => !a.inline)}⎘&nbsp;&nbsp;{/if}{shortDate(
								record.date
							)}</span
						>
					</button>
					{#if expanded.has(record.id)}
						<MessageCard
							{record}
							message={opened.get(record.id)?.message ?? null}
							error={opened.get(record.id)?.error ?? null}
							{images}
							ondownload={() => ondownload(record)}
							oninline={() => oninline(record)}
							onsource={() => onsource(record)}
							onattachment={(attachment) => onattachment(record, attachment)}
						/>
					{/if}
				</li>
			{/each}
		</ol>
	</div>
</article>

<style>
	.reader {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		height: 44px;
		padding: 0 var(--space-4);
		border-bottom: var(--hairline);
		flex: none;
	}

	.back,
	.step {
		display: inline-flex;
		align-items: center;
		height: 26px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		text-decoration: none;
	}

	.back {
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
	}

	.images {
		margin-left: var(--space-2);
		border: 1px solid transparent;
		background: transparent;
		cursor: pointer;
	}

	.images[aria-pressed='true'] {
		border-color: var(--border-strong);
		color: var(--text-body);
	}

	.back:hover,
	.step:hover {
		background: var(--surface-inset);
		color: var(--text-body);
	}

	.step[aria-disabled='true'] {
		opacity: 0.4;
		pointer-events: none;
	}

	.place {
		margin-left: auto;
		font: var(--mono-sm) var(--font-mono);
		color: var(--text-faint);
	}

	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-5) var(--space-6) var(--space-7);
	}

	.summary {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: var(--space-5);
	}

	h1 {
		margin: 0;
		font: 600 var(--body-xl) / 1.3 var(--font-body);
		overflow-wrap: anywhere;
	}

	.facts {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
		font: var(--mono-sm) var(--font-mono);
		color: var(--text-faint);
	}

	.label {
		display: inline-flex;
		align-items: center;
		height: 18px;
		padding: 0 6px;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-muted);
		font: var(--mono-xs) / 1 var(--font-mono);
	}

	.messages {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: var(--hairline);
	}

	li {
		border-bottom: var(--hairline);
	}

	.row {
		display: grid;
		grid-template-columns: 130px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		width: 100%;
		min-height: 40px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-panel);
	}

	.from {
		font: var(--mono-md) var(--font-mono);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.snippet {
		font: var(--body-sm) var(--font-body);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open .snippet {
		color: var(--text-body);
	}

	.date {
		font: var(--mono-sm) var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
