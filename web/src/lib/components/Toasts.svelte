<!--
  The toast stack at the corner of the shell. Each toast carries a tag,
  a sentence and at most one action, and can be dismissed by hand before
  it goes on its own.
-->
<script lang="ts">
	import { toasts } from '$lib/state/toasts.svelte';
	import Tag from './Tag.svelte';
</script>

<div class="stack" aria-live="polite">
	{#each toasts.items as toast (toast.id)}
		<div class="toast" role={toast.tone === 'danger' ? 'alert' : 'status'} data-testid="toast">
			<Tag tone={toast.tone}>{toast.label}</Tag>
			<span class="message">{toast.message}</span>
			{#if toast.action}
				<a class="action" href={toast.action.href} onclick={() => toasts.dismiss(toast.id)}>
					{toast.action.label}
				</a>
			{/if}
			<button
				class="close"
				type="button"
				aria-label="Dismiss"
				onclick={() => toasts.dismiss(toast.id)}
			>
				×
			</button>
		</div>
	{/each}
</div>

<style>
	.stack {
		position: fixed;
		right: var(--space-5);
		bottom: var(--space-5);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: min(360px, calc(100vw - 2 * var(--space-5)));
	}

	.toast {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 12px 14px;
		border-radius: var(--radius-md);
		background: var(--surface-page);
		box-shadow: var(--shadow-pop);
	}

	.message {
		flex: 1;
		font: var(--body-sm) / var(--body-leading) var(--font-body);
	}

	.action {
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		text-decoration: none;
		white-space: nowrap;
		color: var(--text-body);
	}

	.close {
		all: unset;
		cursor: pointer;
		padding: 0 4px;
		font: var(--mono-lg) var(--font-mono);
		color: var(--text-muted);
	}

	.close:focus-visible {
		box-shadow: var(--focus-ring);
	}
</style>
