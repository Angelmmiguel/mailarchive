<!--
  A labelled text input: mono uppercase label, 32px control, optional hint
  or error underneath. Anything else the input accepts is passed through.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		label: string;
		value?: string;
		hint?: string;
		error?: string | null;
		/** Rendered under the input, before the hint. */
		below?: Snippet;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		error = null,
		below,
		id = `field-${crypto.randomUUID().slice(0, 8)}`,
		...rest
	}: Props = $props();

	const messageId = $derived(`${id}-message`);
</script>

<div class="field">
	<label class="label" for={id}>{label}</label>
	<span class="control" class:invalid={error !== null}>
		<input
			{...rest}
			{id}
			bind:value
			aria-invalid={error !== null || undefined}
			aria-describedby={error !== null || hint !== undefined ? messageId : undefined}
		/>
	</span>
	{#if below}{@render below()}{/if}
	{#if error !== null}
		<span class="message error" id={messageId}>{error}</span>
	{:else if hint !== undefined}
		<span class="message" id={messageId}>{hint}</span>
	{/if}
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.label {
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.control {
		display: flex;
		align-items: center;
		height: var(--control-h);
		padding: 0 10px;
		background: var(--surface-page);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}

	.control:focus-within {
		border-color: var(--border-focus);
		box-shadow: var(--focus-ring);
	}

	.invalid {
		border-color: var(--danger-ink);
	}

	input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		font: var(--body-md) var(--font-body);
		color: var(--text-body);
	}

	input:focus-visible {
		box-shadow: none;
	}

	input::placeholder {
		color: var(--text-faint);
	}

	.message {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}

	.error {
		color: var(--danger-ink);
	}
</style>
