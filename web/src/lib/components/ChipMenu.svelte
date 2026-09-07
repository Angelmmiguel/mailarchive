<!--
  A filter chip that opens a menu of choices, grouped. The chip reads as
  the styleguide's tag, pressed while a choice other than the default is
  on; the menu is a list of radio items. Closes on choosing, on Escape and
  on a click elsewhere or when focus leaves; arrows move through the items.
-->
<script lang="ts">
	export interface Item {
		id: string;
		label: string;
		checked: boolean;
		group: string;
	}

	interface Props {
		label: string;
		active?: boolean;
		items: Item[];
		onselect: (id: string) => void;
	}

	let { label, active = false, items, onselect }: Props = $props();
	let open = $state(false);
	let root = $state<HTMLElement | null>(null);
	const groups = $derived([...new Set(items.map((i) => i.group))]);

	function outside(event: MouseEvent): void {
		if (root !== null && !root.contains(event.target as Node)) open = false;
	}

	function keydown(event: KeyboardEvent): void {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			root?.querySelector('button')?.focus();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const buttons = [...(root?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
		if (buttons.length === 0) return;
		event.preventDefault();
		const at = buttons.indexOf(document.activeElement as HTMLElement);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		const next = at === -1 ? (step > 0 ? 0 : buttons.length - 1) : at + step;
		buttons[(next + buttons.length) % buttons.length].focus();
	}

	function focusout(event: FocusEvent): void {
		const to = event.relatedTarget;
		if (root !== null && !(to instanceof Node && root.contains(to))) open = false;
	}

	function choose(id: string): void {
		open = false;
		onselect(id);
	}
</script>

<svelte:window onmousedown={outside} />

<span class="menu" bind:this={root} onkeydown={keydown} onfocusout={focusout} role="presentation">
	<button
		type="button"
		class="chip"
		class:active
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{label} <span class="caret" aria-hidden="true">▾</span>
	</button>
	{#if open}
		<div class="list" role="menu" aria-label={label}>
			{#each groups as group (group)}
				<div class="group" role="group" aria-label={group}>
					{#each items.filter((i) => i.group === group) as item (item.id)}
						<button
							type="button"
							role="menuitemradio"
							aria-checked={item.checked}
							onclick={() => choose(item.id)}>{item.label}</button
						>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</span>

<style>
	.menu {
		position: relative;
		display: inline-flex;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 20px;
		padding: 0 7px;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-body);
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: 0.03em;
		cursor: pointer;
	}

	.active {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.caret {
		opacity: 0.6;
	}

	.list {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 20;
		min-width: 180px;
		padding: 4px 0;
		background: var(--surface-page);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pop);
	}

	.group + .group {
		margin-top: 4px;
		padding-top: 4px;
		border-top: var(--hairline);
	}

	[role='menuitemradio'] {
		display: flex;
		align-items: center;
		width: 100%;
		height: 28px;
		padding: 0 12px 0 28px;
		border: 0;
		background: transparent;
		color: var(--text-body);
		font: var(--body-sm) var(--font-body);
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
		position: relative;
	}

	[role='menuitemradio']:hover,
	[role='menuitemradio']:focus-visible {
		background: var(--surface-inset);
		outline: 0;
		box-shadow: none;
	}

	[aria-checked='true']::before {
		content: '✓';
		position: absolute;
		left: 10px;
		font: var(--mono-sm) var(--font-mono);
	}
</style>
