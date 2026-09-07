<!--
  Where the 24 words of a recovery key are typed or pasted: a mono text
  area that submits its form on Enter, with the same label, hint and error
  treatment as a Field. Case and spacing are the account layer's to
  forgive; this only collects the text.
-->
<script lang="ts">
	interface Props {
		value?: string;
		error?: string | null;
		disabled?: boolean;
	}

	let { value = $bindable(''), error = null, disabled = false }: Props = $props();

	const id = `recovery-key-${crypto.randomUUID().slice(0, 8)}`;
	const messageId = `${id}-message`;
	let area = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		area?.focus();
	});

	function keydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		area?.form?.requestSubmit();
	}
</script>

<div class="field">
	<label class="label" for={id}>Recovery key</label>
	<span class="control" class:invalid={error !== null}>
		<textarea
			bind:this={area}
			bind:value
			{id}
			name="recovery-key"
			rows="3"
			{disabled}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			placeholder="the 24 words, in order"
			aria-invalid={error !== null || undefined}
			aria-describedby={messageId}
			onkeydown={keydown}></textarea>
	</span>
	{#if error !== null}
		<span class="message error" id={messageId} role="alert">{error}</span>
	{:else}
		<span class="message" id={messageId}>Case and line breaks do not matter</span>
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
		padding: 8px 10px;
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

	textarea {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		padding: 0;
		background: transparent;
		resize: none;
		font: var(--mono-md) / 1.6 var(--font-mono);
		letter-spacing: 0.04em;
		color: var(--text-body);
	}

	textarea::placeholder {
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
