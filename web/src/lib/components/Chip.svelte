<!--
  A filter chip: pressed, it narrows the list and shows the × that lifts
  it. The styleguide's inset tag when off, its ink tag when on.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		active?: boolean;
		onclick?: () => void;
		children: Snippet;
	}

	let { active = false, onclick, children }: Props = $props();
</script>

<button type="button" class="chip" class:active aria-pressed={active} {onclick}>
	{@render children()}
	{#if active}<span class="off" aria-hidden="true">×</span>{/if}
</button>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 20px;
		padding: 0 7px;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-body);
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: 0.03em;
		cursor: pointer;
	}

	.active {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.off {
		opacity: 0.6;
	}
</style>
