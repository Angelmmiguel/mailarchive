<!--
  A one-line accent strip inside a pane, with the action it suggests:
  the list uses it to say another device added segments since unlock.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		action: string;
		busy?: boolean;
		onaction: () => void;
		children: Snippet;
	}

	let { action, busy = false, onaction, children }: Props = $props();
</script>

<div class="strip" role="status">
	<span>{@render children()}</span>
	<button type="button" onclick={onaction} disabled={busy}>{action}</button>
</div>

<style>
	.strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 36px;
		padding: 0 var(--space-4);
		background: var(--accent-soft);
		color: var(--accent-ink);
		font: var(--mono-md) / var(--mono-leading) var(--font-mono);
		flex: none;
	}

	button {
		border: 0;
		padding: 0;
		background: none;
		color: inherit;
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
