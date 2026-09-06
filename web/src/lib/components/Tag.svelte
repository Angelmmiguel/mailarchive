<!-- A small mono label: the styleguide's tags and badges. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'neutral' | 'accent' | 'ok' | 'danger';
		children: Snippet;
	}

	let { tone = 'neutral', children }: Props = $props();
</script>

<span class="tag {tone}">{@render children()}</span>

<style>
	.tag {
		display: inline-flex;
		align-items: center;
		height: 20px;
		padding: 0 7px;
		border-radius: var(--radius-sm);
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: 0.03em;
		white-space: nowrap;
	}

	.neutral {
		background: var(--surface-inset);
		color: var(--text-muted);
	}

	.accent {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}

	.ok {
		background: var(--ok-soft);
		color: var(--ok-ink);
	}

	.danger {
		background: var(--danger-soft);
		color: var(--danger-ink);
	}
</style>
