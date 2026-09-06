<!-- A checkbox with its label as body text; the box is drawn in CSS. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		checked?: boolean;
		disabled?: boolean;
		name?: string;
		children: Snippet;
	}

	let { checked = $bindable(false), disabled = false, name, children }: Props = $props();
</script>

<label class="checkbox" class:disabled>
	<input type="checkbox" bind:checked {disabled} {name} />
	<span class="box" aria-hidden="true"></span>
	<span class="text">{@render children()}</span>
</label>

<style>
	.checkbox {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		cursor: pointer;
	}

	.disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.checkbox {
		position: relative;
	}

	/* The real input sits over the drawn box, invisible but clickable. */
	input {
		position: absolute;
		top: 2px;
		left: 0;
		width: 16px;
		height: 16px;
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}

	.box {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
	}

	input:checked + .box {
		background: var(--surface-ink);
		border-color: var(--surface-ink);
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-6' fill='none' stroke='white' stroke-width='1.8'/%3E%3C/svg%3E");
	}

	input:focus-visible + .box {
		box-shadow: var(--focus-ring);
	}

	.text {
		font: var(--body-md) / var(--body-leading) var(--font-body);
	}
</style>
