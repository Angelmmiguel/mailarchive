<!-- An inline identifier inside body text, such as a label name. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<code>{@render children()}</code>

<style>
	code {
		padding: 2px 5px;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		font: var(--mono-sm) var(--font-mono);
	}
</style>
