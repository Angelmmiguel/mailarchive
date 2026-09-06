<!--
  The styleguide's buttons. `busy` shows the working state for the slow
  operations (key derivation) and disables the button while it lasts.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';
		size?: 'md' | 'sm';
		busy?: boolean;
		children: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		busy = false,
		disabled = false,
		type = 'button',
		children,
		...rest
	}: Props = $props();
</script>

<button
	{...rest}
	{type}
	class="button {variant} {size}"
	disabled={disabled || busy}
	aria-busy={busy || undefined}
>
	{#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
	{@render children()}
</button>

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: var(--control-h);
		padding: 0 14px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 80ms linear;
	}

	.sm {
		height: var(--control-h-sm);
		padding: 0 10px;
		font-size: var(--mono-sm);
	}

	.primary {
		background: var(--surface-ink);
		border-color: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.primary:hover:enabled {
		background: var(--n-7);
		border-color: var(--n-7);
	}

	.secondary {
		background: var(--surface-page);
		border-color: var(--border-strong);
		color: var(--text-body);
	}

	.ghost {
		background: transparent;
		color: var(--text-muted);
	}

	.secondary:hover:enabled,
	.ghost:hover:enabled {
		background: var(--surface-inset);
	}

	.accent {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--text-on-accent);
	}

	.danger {
		background: transparent;
		border-color: var(--danger-ink);
		color: var(--danger-ink);
	}

	.danger:hover:enabled {
		background: var(--danger-soft);
	}

	.button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.spinner {
		width: 10px;
		height: 10px;
		border: 1.5px solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
		}
	}
</style>
