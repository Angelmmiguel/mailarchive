<!-- A persistent full-width strip at the top of the shell, for warnings. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'danger' | 'accent';
		children: Snippet;
	}

	let { tone = 'danger', children }: Props = $props();
</script>

<div class="banner {tone}" role="alert">{@render children()}</div>

<style>
	.banner {
		padding: 10px var(--space-5);
		font: var(--body-sm) / var(--body-leading) var(--font-body);
		border-bottom: var(--hairline);
	}

	.danger {
		background: var(--danger-soft);
		color: var(--danger-ink);
	}

	.accent {
		background: var(--accent-soft);
		color: var(--accent-ink);
	}
</style>
