<!--
  The bar above every view after unlock: the wordmark, the search entry and
  the actions. Lock reports the outcome through `busy` while the server is
  told; the screen behind decides where to go next.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	interface Props {
		search?: Snippet;
		onimport?: () => void;
		onsettings?: () => void;
		onlock: () => Promise<void> | void;
	}

	let { search, onimport, onsettings, onlock }: Props = $props();
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
		<Button onclick={onimport} disabled={onimport === undefined}>Import</Button>
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
</style>
