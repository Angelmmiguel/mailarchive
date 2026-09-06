<!--
  One onboarding screen: a step counter, a mono title, a body-text lead and
  the content, centred in the page. `notice` renders at the foot.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		step: number;
		total?: number;
		title: string;
		/** Hide the step counter on a screen that is not part of a sequence. */
		counter?: boolean;
		width?: 'narrow' | 'wide';
		lead?: Snippet;
		notice?: Snippet;
		children: Snippet;
	}

	let {
		step,
		total = 3,
		title,
		counter = true,
		width = 'narrow',
		lead,
		notice,
		children
	}: Props = $props();
</script>

<section class="step {width}" aria-labelledby="step-title">
	<header>
		{#if counter}<span class="counter">Step {step} of {total}</span>{/if}
		<h1 id="step-title">{title}</h1>
		{#if lead}<p class="lead">{@render lead()}</p>{/if}
	</header>
	{@render children()}
</section>
{#if notice}
	<footer class="notice">{@render notice()}</footer>
{/if}

<style>
	.step {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		width: 100%;
		max-width: 360px;
		margin: auto;
		padding: var(--space-6) 0;
		transform: translateY(-40px);
	}

	.wide {
		max-width: 440px;
	}

	header {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.counter {
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	h1 {
		margin: 0;
		font: 500 var(--mono-2xl) / 1.2 var(--font-mono);
	}

	.lead {
		margin: 0;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}

	.notice {
		position: fixed;
		left: var(--space-5);
		bottom: 20px;
		right: var(--space-5);
	}
</style>
