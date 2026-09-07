<!--
  One numbered step of a flow that unfolds on a single screen: a badge
  that turns into a check once the step is done, the uppercase label, and
  the step's content indented under it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		number: number;
		label: string;
		state: 'done' | 'current' | 'pending';
		children?: Snippet;
	}

	let { number, label, state, children }: Props = $props();
</script>

<section
	class="flow-step {state}"
	aria-current={state === 'current' ? 'step' : undefined}
	aria-label="{number} · {label}"
>
	<div class="head">
		<span class="badge" aria-hidden="true">{state === 'done' ? '✓' : number}</span>
		<span class="label">{number} · {label}</span>
	</div>
	{#if children}
		<div class="body">{@render children()}</div>
	{/if}
</section>

<style>
	.flow-step {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.head {
		display: flex;
		gap: 12px;
		align-items: baseline;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 18px;
		height: 18px;
		border-radius: 9px;
		background: var(--surface-inset);
		color: var(--text-faint);
		font: 500 var(--mono-xs) / 1 var(--font-mono);
	}

	.current .badge {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.done .badge {
		background: var(--ok-soft);
		color: var(--ok-ink);
		font-size: var(--mono-sm);
	}

	.label {
		font: var(--mono-sm) / 1.4 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.current .label {
		color: var(--text-body);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		margin-left: 30px;
	}

	.done {
		gap: var(--space-3);
	}
</style>
