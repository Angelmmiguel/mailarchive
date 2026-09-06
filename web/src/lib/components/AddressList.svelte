<!--
  An editable list of email addresses. The component owns the input, its
  validation message and the add and remove interactions; the validated
  list is what it binds outwards.
-->
<script lang="ts">
	import { addAddress, normalizeAddress } from '$lib/account/addresses';
	import Button from './Button.svelte';

	interface Props {
		addresses?: string[];
		disabled?: boolean;
		placeholder?: string;
	}

	let {
		addresses = $bindable([]),
		disabled = false,
		placeholder = 'Add another address'
	}: Props = $props();

	let draft = $state('');
	let error = $state<string | null>(null);

	/** Adds the draft to the list; reports false if it is not an address. */
	export function add(): boolean {
		if (draft.trim() === '') return false;
		const address = normalizeAddress(draft);
		if (address === null) {
			error = 'Not an email address';
			return false;
		}
		addresses = addAddress(addresses, address);
		draft = '';
		error = null;
		return true;
	}

	/** Whether something is typed in the entry that is not in the list. */
	export function hasDraft(): boolean {
		return draft.trim() !== '';
	}

	function remove(address: string): void {
		addresses = addresses.filter((a) => a !== address);
	}

	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			add();
		}
	}
</script>

<div class="list">
	<ul>
		{#each addresses as address (address)}
			<li>
				<span class="address" data-testid="address">{address}</span>
				<button
					type="button"
					class="remove"
					onclick={() => remove(address)}
					{disabled}
					aria-label="Remove {address}"
				>
					×
				</button>
			</li>
		{/each}
	</ul>
	<div class="entry" class:invalid={error !== null}>
		<input
			type="email"
			bind:value={draft}
			oninput={() => (error = null)}
			{onkeydown}
			{placeholder}
			{disabled}
			aria-label="Email address"
			aria-invalid={error !== null || undefined}
			autocomplete="email"
			spellcheck="false"
		/>
		<Button variant="ghost" size="sm" onclick={add} disabled={disabled || draft.trim() === ''}>
			Add
		</Button>
	</div>
	{#if error !== null}
		<span class="error" role="alert">{error}</span>
	{/if}
</div>

<style>
	.list {
		display: flex;
		flex-direction: column;
		border: var(--hairline);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		height: var(--row-h);
		padding: 0 var(--space-3);
		border-bottom: var(--hairline);
	}

	.address {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: var(--body-sm) var(--font-mono);
	}

	.remove {
		all: unset;
		padding: 0 var(--space-1);
		font: var(--mono-lg) var(--font-mono);
		color: var(--text-faint);
		cursor: pointer;
	}

	.remove:hover {
		color: var(--text-body);
	}

	.remove:focus-visible {
		box-shadow: var(--focus-ring);
		border-radius: var(--radius-sm);
	}

	.entry {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: var(--row-h);
		padding: 0 var(--space-1) 0 var(--space-3);
	}

	.entry:focus-within {
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.invalid {
		box-shadow: inset 2px 0 0 var(--danger);
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

	.error {
		padding: 6px var(--space-3);
		border-top: var(--hairline);
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--danger-ink);
	}
</style>
