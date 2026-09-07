<!--
  The bar above every view after unlock: the wordmark, the search entry and
  the actions. Import shows the running import's percent and reopens its
  panel; Lock reports through `busy` while the server is told.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	interface Props {
		search?: Snippet;
		/** Percent of a running import, or null. */
		importing?: number | null;
		onimport?: () => void;
		onsettings?: () => void;
		onlock: () => Promise<void> | void;
	}

	let { search, importing = null, onimport, onsettings, onlock }: Props = $props();
	let locking = $state(false);

	async function lock(): Promise<void> {
		locking = true;
		try {
			await onlock();
		} finally {
			locking = false;
		}
	}
</script>

<header class="toolbar">
	<span class="brand">ARCHIVE</span>
	{#if search}<div class="search">{@render search()}</div>{/if}
	<nav class="actions" aria-label="Archive">
		{#if importing !== null}
			<button
				class="importing"
				type="button"
				onclick={onimport}
				aria-label="Import, {importing}% done"
			>
				Import <span class="percent">{importing}%</span>
				<i class="fill" style:width="{importing}%"></i>
			</button>
		{:else}
			<Button onclick={onimport} disabled={onimport === undefined}>Import</Button>
		{/if}
		<Button variant="ghost" onclick={onsettings} disabled={onsettings === undefined}
			>Settings</Button
		>
		<Button variant="ghost" onclick={lock} busy={locking}>Lock</Button>
	</nav>
</header>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		height: 48px;
		padding: 0 var(--space-4) 0 var(--space-5);
		border-bottom: var(--hairline);
		flex: none;
	}

	.brand {
		width: 120px;
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
	}

	.search {
		flex: 1;
		display: flex;
		min-width: 0;
	}

	.actions {
		margin-left: auto;
		display: flex;
		gap: var(--space-1);
		align-items: center;
	}

	.importing {
		position: relative;
		overflow: hidden;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		height: var(--control-h);
		padding: 0 14px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-body);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	.percent {
		font-weight: 400;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.fill {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		background: var(--accent);
		transition: width 200ms linear;
	}
</style>
