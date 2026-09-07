<!-- One section of Settings: a mono label in the margin and the content beside it. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		children: Snippet;
	}

	let { title, children }: Props = $props();
</script>

<section class="section" aria-label={title}>
	<h2>{title}</h2>
	<div class="content">{@render children()}</div>
</section>

<style>
	.section {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr);
		gap: var(--space-5);
		padding-top: var(--space-5);
		border-top: var(--hairline);
	}

	h2 {
		margin: 0;
		font: var(--mono-sm) / 1.4 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	@media (max-width: 719px) {
		.section {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-3);
		}
	}
</style>
