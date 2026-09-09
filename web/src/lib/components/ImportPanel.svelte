<!--
  The import panel over the archive: the drop zone before a run, the
  progress, counts, failures and the files already archived during and after it. The user can close
  it and keep browsing; the toolbar shows the run is still going.
-->
<script lang="ts">
	import { importState } from '$lib/state/import.svelte';
	import type { ImportFile } from '$lib/import/sources';
	import Button from './Button.svelte';
	import DropZone from './DropZone.svelte';
	import ProgressBar from './ProgressBar.svelte';

	interface Props {
		onfiles: (files: ImportFile[]) => void;
		oncancel: () => void;
		onclose: () => void;
		/** Clears the finished run so the zone shows again. */
		onreset: () => void;
	}

	let { onfiles, oncancel, onclose, onreset }: Props = $props();
	let panel = $state<HTMLElement | null>(null);

	// Opened by a button elsewhere: bring the keyboard along, and let
	// Escape close it the way the × does.
	$effect(() => {
		panel?.focus();
	});

	function keydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') onclose();
	}
	const counts = $derived(importState.counts);
	const showRun = $derived(importState.status !== 'idle');
	const eta = $derived.by(() => {
		const s = importState.remaining;
		if (s === null) return null;
		if (s < 60) return 'under a minute left';
		return `about ${Math.ceil(s / 60)} min left`;
	});
	const stats = $derived([
		{ label: 'Parsed', value: counts.parsed, tone: '' },
		{ label: 'Uploaded', value: counts.uploaded, tone: '' },
		{ label: 'Duplicates', value: counts.duplicates, tone: 'muted' },
		{ label: 'Failed', value: counts.failed, tone: 'danger' }
	]);
</script>

<svelte:window onkeydown={keydown} />

<aside
	class="panel"
	aria-labelledby="import-title"
	data-testid="import-panel"
	tabindex="-1"
	bind:this={panel}
>
	<header>
		<span id="import-title">Import</span>
		<button class="close" type="button" aria-label="Close import panel" onclick={onclose}>×</button>
	</header>
	<div class="body">
		{#if showRun}
			<section class="progress">
				<div class="head">
					<span>
						{#if importState.status === 'running'}Importing {importState.label}
						{:else if importState.status === 'committing'}Writing the index
						{:else if importState.status === 'cancelled'}Stopped {importState.label}
						{:else}Imported {importState.label}{/if}
					</span>
					<span class="muted">{importState.percent}%</span>
				</div>
				<ProgressBar value={importState.percent} label="Import progress" />
				<div class="detail">
					{#if importState.status === 'committing'}
						blob {importState.writing.done.toLocaleString()} of {importState.writing.total.toLocaleString()}
					{:else}
						{counts.processed.toLocaleString()} of {counts.total.toLocaleString()} files
						{#if importState.active && eta !== null}· {eta}{/if}
					{/if}
				</div>
			</section>
			<dl class="stats">
				{#each stats as stat (stat.label)}
					<div class="stat {stat.tone}">
						<dt>{stat.label}</dt>
						<dd>{stat.value.toLocaleString()}</dd>
					</div>
				{/each}
			</dl>
			{#if importState.error !== null}
				<p class="error" role="alert">{importState.error}</p>
			{/if}
			{#if importState.failures.length > 0}
				<section class="failures">
					<h2>Could not import</h2>
					<ul>
						{#each importState.failures as failure, i (i)}
							<li>
								<span class="path">{failure.path}</span><span class="why">{failure.reason}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			{#if importState.duplicates.length > 0}
				<section class="failures" data-testid="duplicates">
					<h2>Already in the archive</h2>
					<ul>
						{#each importState.duplicates as duplicate, i (i)}
							<li>
								<span class="path">{duplicate.path}</span><span class="how">{duplicate.reason}</span
								>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			<footer>
				{#if importState.active}
					<span class="aside">Close to keep browsing</span>
					<Button
						variant="danger"
						onclick={oncancel}
						disabled={importState.status === 'committing'}
					>
						Cancel import
					</Button>
				{:else}
					<span class="aside">Drop more files to import again</span>
					<Button variant="secondary" onclick={onreset}>Import more</Button>
				{/if}
			</footer>
		{:else}
			<DropZone {onfiles} />
		{/if}
	</div>
</aside>

<style>
	.panel {
		position: fixed;
		top: 48px;
		right: 0;
		bottom: 0;
		z-index: 10;
		width: min(440px, 100vw);
		display: flex;
		flex-direction: column;
		background: var(--surface-page);
		border-left: var(--hairline);
		box-shadow: var(--shadow-pop);
		overflow-y: auto;
		outline: 0;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 44px;
		padding: 0 12px 0 20px;
		border-bottom: var(--hairline);
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		flex: none;
	}

	.close {
		all: unset;
		cursor: pointer;
		padding: 6px;
		font: 16px var(--font-mono);
		color: var(--text-muted);
	}

	.close:focus-visible {
		box-shadow: var(--focus-ring);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		padding: var(--space-5) 20px;
	}

	.progress {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		font: var(--mono-md) var(--font-mono);
	}

	.muted {
		color: var(--text-muted);
	}

	.detail,
	.aside {
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}

	.stats {
		display: grid;
		grid-template-columns: 1fr 1fr;
		margin: 0;
		border-top: var(--hairline);
		border-left: var(--hairline);
	}

	.stat {
		padding: 12px;
		border-right: var(--hairline);
		border-bottom: var(--hairline);
	}

	dt {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	dd {
		margin: 0;
		font: 500 var(--mono-xl) / 1.3 var(--font-mono);
		font-variant-numeric: tabular-nums;
	}

	.stat.muted dd {
		color: var(--text-muted);
	}

	.stat.danger dd {
		color: var(--danger-ink);
	}

	.error {
		margin: 0;
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		color: var(--danger-ink);
	}

	.failures {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	h2 {
		margin: 0;
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		font: var(--mono-md) var(--font-mono);
		color: var(--text-muted);
	}

	.path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.why {
		color: var(--danger-ink);
		white-space: nowrap;
	}

	.how {
		color: var(--text-faint);
		white-space: nowrap;
	}

	footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		padding-top: var(--space-4);
		border-top: var(--hairline);
	}
</style>
