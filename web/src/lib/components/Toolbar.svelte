<!--
  The bar above every view after unlock: the wordmark, which is the way
  back to the archive from any screen, the search entry and the actions.
  Import shows the running import's percent and reopens its panel;
  Settings is marked as current while its screen is open; Lock reports
  through `busy` while the server is told. On a narrow screen the three
  actions fold into one menu, so the search entry keeps its room.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ResolvedPathname } from '$app/types';
	import Button from './Button.svelte';

	interface Props {
		/** Where the wordmark leads: the archive. */
		home: ResolvedPathname;
		search?: Snippet;
		/** Percent of a running import, or null. */
		importing?: number | null;
		onimport?: () => void;
		onsettings?: () => void;
		/** Whether the Settings screen is the one open. */
		settingsOpen?: boolean;
		onlock: () => Promise<void> | void;
	}

	let {
		home,
		search,
		importing = null,
		onimport,
		onsettings,
		settingsOpen = false,
		onlock
	}: Props = $props();
	let locking = $state(false);

	/** Below this the actions fold into the menu. */
	const NARROW = '(max-width: 719px)';
	let narrow = $state(false);
	let open = $state(false);
	let menu = $state<HTMLElement | null>(null);

	$effect(() => {
		const query = window.matchMedia(NARROW);
		const follow = (): void => {
			narrow = query.matches;
			if (!narrow) open = false;
		};
		follow();
		query.addEventListener('change', follow);
		return () => query.removeEventListener('change', follow);
	});

	async function lock(): Promise<void> {
		locking = true;
		try {
			await onlock();
		} finally {
			locking = false;
		}
	}

	function pick(action: (() => void) | undefined): void {
		open = false;
		action?.();
	}

	function outside(event: MouseEvent): void {
		if (menu !== null && !menu.contains(event.target as Node)) open = false;
	}

	function keydown(event: KeyboardEvent): void {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			menu?.querySelector('button')?.focus();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		const items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		if (items.length === 0) return;
		event.preventDefault();
		const at = items.indexOf(document.activeElement as HTMLElement);
		const step = event.key === 'ArrowDown' ? 1 : -1;
		const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : at + step;
		items[(next + items.length) % items.length].focus();
	}

	function focusout(event: FocusEvent): void {
		const to = event.relatedTarget;
		if (menu !== null && !(to instanceof Node && menu.contains(to))) open = false;
	}
</script>

<svelte:window onmousedown={outside} />

<header class="toolbar" class:narrow>
	<a class="brand" href={home}>ARCHIVE</a>
	{#if search}<div class="search">{@render search()}</div>{/if}
	<nav class="actions" aria-label="Archive">
		{#if narrow}
			<div
				class="menu"
				bind:this={menu}
				onkeydown={keydown}
				onfocusout={focusout}
				role="presentation"
			>
				<button
					type="button"
					class="burger"
					aria-label={importing === null ? 'Menu' : `Menu, import ${importing}% done`}
					aria-haspopup="menu"
					aria-expanded={open}
					onclick={() => (open = !open)}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2 4h12M2 8h12M2 12h12" />
					</svg>
					{#if importing !== null}<i class="fill" style:width="{importing}%"></i>{/if}
				</button>
				{#if open}
					<div class="list" role="menu" aria-label="Archive">
						<button
							type="button"
							role="menuitem"
							onclick={() => pick(onimport)}
							disabled={onimport === undefined}
						>
							Import
							{#if importing !== null}<span class="percent">{importing}%</span>{/if}
						</button>
						<button
							type="button"
							role="menuitem"
							onclick={() => pick(onsettings)}
							disabled={onsettings === undefined}
							aria-current={settingsOpen ? 'page' : undefined}
						>
							Settings
						</button>
						<button type="button" role="menuitem" onclick={() => pick(lock)} disabled={locking}>
							Lock
						</button>
					</div>
				{/if}
			</div>
		{:else}
			{#if importing !== null}
				<button
					class="importing"
					type="button"
					onclick={onimport}
					aria-label="Import, {importing}% done"
				>
					Import <span class="percent">{importing}%</span>
					<i class="fill" style:width="{importing}%"></i>
				</button>
			{:else}
				<Button onclick={onimport} disabled={onimport === undefined}>Import</Button>
			{/if}
			<Button
				variant="ghost"
				onclick={onsettings}
				disabled={onsettings === undefined}
				aria-current={settingsOpen ? 'page' : undefined}>Settings</Button
			>
			<Button variant="ghost" onclick={lock} busy={locking}>Lock</Button>
		{/if}
	</nav>
</header>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		height: 48px;
		padding: 0 var(--space-4) 0 var(--space-5);
		border-bottom: var(--hairline);
		flex: none;
	}

	.narrow {
		gap: var(--space-3);
		padding: 0 var(--space-3) 0 var(--space-4);
	}

	.brand {
		width: 120px;
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		color: inherit;
		text-decoration: none;
	}

	.narrow .brand {
		width: auto;
		flex: none;
	}

	.brand:hover {
		color: var(--accent);
	}

	.brand:focus-visible {
		outline: 0;
		box-shadow: var(--focus-ring);
		border-radius: var(--radius-sm);
	}

	.search {
		flex: 1;
		display: flex;
		min-width: 0;
	}

	.actions {
		margin-left: auto;
		display: flex;
		gap: var(--space-1);
		align-items: center;
		flex: none;
	}

	.importing {
		position: relative;
		overflow: hidden;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		height: var(--control-h);
		padding: 0 14px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		color: var(--text-body);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	.percent {
		font-weight: 400;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.fill {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 2px;
		background: var(--accent);
		transition: width 200ms linear;
	}

	.menu {
		position: relative;
		display: inline-flex;
	}

	.burger {
		position: relative;
		overflow: hidden;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-h);
		height: var(--control-h);
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-body);
		cursor: pointer;
	}

	.burger:hover,
	.burger[aria-expanded='true'] {
		background: var(--surface-inset);
	}

	.burger svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
	}

	.list {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 20;
		min-width: 180px;
		padding: 4px 0;
		background: var(--surface-page);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pop);
	}

	[role='menuitem'] {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		height: 36px;
		padding: 0 14px;
		border: 0;
		background: transparent;
		color: var(--text-body);
		font: 500 var(--mono-md) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	[role='menuitem']:hover:not(:disabled),
	[role='menuitem']:focus-visible {
		background: var(--surface-inset);
		outline: 0;
		box-shadow: none;
	}

	[role='menuitem'][aria-current='page'] {
		color: var(--accent-ink);
	}

	[role='menuitem']:disabled {
		color: var(--text-faint);
		cursor: default;
	}
</style>
