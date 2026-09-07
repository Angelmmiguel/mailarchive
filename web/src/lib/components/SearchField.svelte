<!--
  The archive's search entry: a slash prefix, the query, the help and the
  shortcut hint. Pressing `/` anywhere on the page focuses it, Escape
  leaves it. The query is only collected here; what it finds belongs to
  the list.
-->
<script lang="ts">
	import SearchHelp from './SearchHelp.svelte';

	interface Props {
		value?: string;
		disabled?: boolean;
		placeholder?: string;
	}

	let {
		value = $bindable(''),
		disabled = false,
		placeholder = 'Search archive…'
	}: Props = $props();
	let input = $state<HTMLInputElement | null>(null);

	function shortcut(event: KeyboardEvent): void {
		if (disabled || input === null) return;
		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
		if (event.key === '/' && !typing) {
			event.preventDefault();
			input.focus();
		} else if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			input.focus();
			input.select();
		} else if (event.key === 'Escape' && target === input) {
			input.blur();
		}
	}

	function pick(query: string): void {
		value = query;
		input?.focus();
	}
</script>

<svelte:window onkeydown={shortcut} />

<div class="search" class:disabled>
	<span class="slash" aria-hidden="true">/</span>
	<input
		type="search"
		bind:this={input}
		bind:value
		{disabled}
		{placeholder}
		aria-label="Search"
		autocomplete="off"
		spellcheck="false"
	/>
	{#if !disabled}<SearchHelp onpick={pick} />{/if}
	<kbd aria-hidden="true">⌘K</kbd>
</div>

<style>
	.search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: var(--control-h);
		width: 100%;
		max-width: 480px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
	}

	.search:focus-within {
		border-color: var(--border-focus);
		box-shadow: var(--focus-ring);
	}

	.disabled {
		opacity: 0.5;
	}

	.slash {
		font: var(--mono-md) var(--font-mono);
		color: var(--text-faint);
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

	kbd {
		padding: 2px 5px;
		border: 1px solid var(--border);
		border-radius: 2px;
		font: 10px/1 var(--font-mono);
		color: var(--text-faint);
	}
</style>
