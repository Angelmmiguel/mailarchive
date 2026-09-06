<!--
  A centred message for a view with nothing to show: an optional mono
  eyebrow, a title, body text and the actions that get the user out of it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		eyebrow?: string;
		title: string;
		children: Snippet;
		actions?: Snippet;
	}

	let { eyebrow, title, children, actions }: Props = $props();
</script>

<section class="empty" aria-labelledby="empty-title">
	{#if eyebrow !== undefined}<span class="eyebrow">{eyebrow}</span>{/if}
	<h1 id="empty-title">{title}</h1>
	<p>{@render children()}</p>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
</section>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		width: 100%;
		max-width: 360px;
		margin: auto;
		padding: var(--space-6) 0;
		transform: translateY(-30px);
	}

	.eyebrow {
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	h1 {
		margin: 0;
		font: 500 var(--mono-xl) / 1.3 var(--font-mono);
	}

	p {
		margin: 0;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
</style>
