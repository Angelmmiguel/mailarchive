<!--
  A small panel in the corner reporting a long step: a title, a percent,
  the line and a detail. Unlock shows it while the index is decrypted.
-->
<script lang="ts">
	import ProgressBar from './ProgressBar.svelte';

	interface Props {
		title: string;
		done: number;
		total: number;
		detail?: string;
	}

	let { title, done, total, detail }: Props = $props();
	const percent = $derived(total === 0 ? 0 : Math.floor((done / total) * 100));
</script>

<aside class="panel" role="status" aria-live="polite">
	<div class="head"><span>{title}</span><span>{percent}%</span></div>
	<ProgressBar value={percent} label={title} />
	{#if detail !== undefined}<div class="detail">{detail}</div>{/if}
</aside>

<style>
	.panel {
		position: fixed;
		right: var(--space-5);
		bottom: 20px;
		width: min(360px, calc(100vw - 2 * var(--space-5)));
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 16px;
		border: var(--hairline);
		border-radius: var(--radius-md);
		background: var(--surface-panel);
	}

	.head {
		display: flex;
		justify-content: space-between;
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.detail {
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}
</style>
