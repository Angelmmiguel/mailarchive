<!--
  One thread in the list: who, what, the first line, when, and how many
  attachments and messages. A link, so the keyboard and the middle click
  behave; the selected row is marked with the accent.
-->
<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import { count, shortDate } from '$lib/app/format';
	import type { Thread } from '$lib/index/threads';
	import { SENT } from '$lib/mail/labels';

	interface Props {
		thread: Thread;
		participants: string;
		href: ResolvedPathname;
		selected?: boolean;
	}

	let { thread, participants, href, selected = false }: Props = $props();
</script>

<a class="row" class:selected {href} aria-current={selected ? 'page' : undefined}>
	<i></i>
	<span class="who">{participants}</span>
	<span class="what">
		<span class="subject">
			<span class="title">{thread.subject}</span>
			{#if thread.labels.includes(SENT)}<span class="label">sent</span>{/if}
		</span>
		<span class="snippet">{thread.latest.snippet}</span>
	</span>
	<span class="when">
		<span>{shortDate(thread.latest.date)}</span>
		{#if thread.attachments > 0 || thread.messages.length > 1}
			<span class="meta">
				{#if thread.attachments > 0}
					<span class="pill" aria-label={count(thread.attachments, 'attachment')}>
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<path
								d="M8.6 3.2v5.1a2.6 2.6 0 0 1-5.2 0V2.9a1.5 1.5 0 0 1 3 0v5.3a.8.8 0 0 1-1.6 0V3.6"
							/>
						</svg>
						{#if thread.attachments > 1}{thread.attachments}{/if}
					</span>
				{/if}
				{#if thread.messages.length > 1}
					<span class="pill" aria-label={count(thread.messages.length, 'message')}>
						<svg viewBox="0 0 12 12" aria-hidden="true">
							<path d="M1.5 2.5h9M1.5 6h9M1.5 9.5h9" />
						</svg>
						{thread.messages.length}
					</span>
				{/if}
			</span>
		{/if}
	</span>
</a>

<style>
	.row {
		display: grid;
		grid-template-columns: 12px 130px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		height: 56px;
		padding: 0 var(--space-4) 0 10px;
		border-bottom: var(--hairline);
		color: inherit;
		text-decoration: none;
	}

	.row:hover {
		background: var(--surface-panel);
		color: inherit;
	}

	.selected,
	.selected:hover {
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.who,
	.title,
	.snippet {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.who {
		font: var(--mono-md) var(--font-mono);
		color: var(--text-muted);
	}

	.what {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.subject {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		min-width: 0;
		font: var(--body-md) var(--font-body);
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
		flex: none;
	}

	.selected .label {
		background: var(--surface-page);
	}

	.snippet {
		font: var(--body-sm) var(--font-body);
		color: var(--text-muted);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 18px;
		padding: 0 6px;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-muted);
	}

	.pill svg {
		width: 10px;
		height: 10px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
	}

	.selected .pill {
		background: var(--surface-page);
	}

	.when {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		font: var(--mono-sm) var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
