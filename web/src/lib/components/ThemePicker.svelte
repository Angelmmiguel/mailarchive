<!--
  The themes as cards. Each card carries its theme's `data-theme`, so it
  is painted in that theme's own tokens: the preview is the theme, not a
  picture of it. System shows whichever look the browser asks for. A radio
  group to the keyboard: arrows move the choice.
-->
<script lang="ts">
	import { THEMES, type Look, type Theme } from '$lib/state/theme.svelte';

	interface Props {
		value: Theme;
		/** What `system` resolves to right now. */
		system: Look;
		onchange: (theme: Theme) => void;
	}

	let { value, system, onchange }: Props = $props();
	let root = $state<HTMLElement | null>(null);

	function keydown(event: KeyboardEvent): void {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		const at = THEMES.findIndex((t) => t.id === value);
		const to = (at + step + THEMES.length) % THEMES.length;
		onchange(THEMES[to].id);
		root?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
	}
</script>

<div class="picker" role="radiogroup" aria-label="Theme" bind:this={root}>
	{#each THEMES as item (item.id)}
		<button
			type="button"
			role="radio"
			class="card"
			class:on={item.id === value}
			aria-checked={item.id === value}
			tabindex={item.id === value ? 0 : -1}
			data-theme={item.id === 'system' ? system : item.id}
			onclick={() => onchange(item.id)}
			onkeydown={keydown}
		>
			<span class="swatch" aria-hidden="true">
				<i class="line"></i>
				<i class="line short"></i>
				<i class="dot"></i>
			</span>
			<span class="name">{item.label}</span>
		</button>
	{/each}
</div>

<style>
	.picker {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
		gap: var(--space-2);
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-body);
		text-align: left;
		cursor: pointer;
	}

	.card:hover {
		border-color: var(--text-faint);
	}

	.card:focus-visible {
		outline: 0;
		box-shadow:
			0 0 0 2px var(--surface-page),
			0 0 0 4px var(--accent);
	}

	.on,
	.on:hover {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.on:focus-visible {
		box-shadow:
			inset 0 0 0 1px var(--accent),
			0 0 0 2px var(--surface-page),
			0 0 0 4px var(--accent);
	}

	.swatch {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 4px;
		height: 40px;
		padding: 7px 8px;
		border: var(--hairline);
		border-radius: var(--radius-sm);
		background: var(--surface-panel);
	}

	.line {
		height: 4px;
		width: 70%;
		border-radius: 2px;
		background: var(--text-body);
	}

	.short {
		width: 45%;
		background: var(--text-muted);
	}

	.dot {
		position: absolute;
		right: 8px;
		bottom: 7px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--accent);
	}

	.name {
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
	}

	.on .name {
		color: var(--accent-ink);
	}
</style>
