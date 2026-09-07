<!--
  The ? beside the search box: a card explaining the query language, with
  examples that fill the box when picked. Opens on click and takes the
  focus; closes on Escape, when focus or a click goes elsewhere, or on
  picking an example, and hands the focus back.
-->
<script lang="ts">
	interface Props {
		onpick: (query: string) => void;
	}

	let { onpick }: Props = $props();
	let open = $state(false);
	let root = $state<HTMLElement | null>(null);
	let toggle = $state<HTMLButtonElement | null>(null);
	let card = $state<HTMLElement | null>(null);

	// Focus follows the card in and comes back to the button after.
	$effect(() => {
		if (open) card?.focus();
	});

	function close(): void {
		if (!open) return;
		open = false;
		toggle?.focus();
	}

	const SYNTAX: [string, string][] = [
		['invoice', 'a word, or the start of one, in the subject, names or body'],
		['"net 30"', 'these words together in the subject or preview; in a body, all of them'],
		['-reminder', 'not this word'],
		['from:okafor', 'sender by name or address; from:me for your own'],
		['to:reyes', 'recipient, in To or Cc; to:me for your own'],
		['subject:budget', 'only in the subject'],
		['has:attachment', 'with a file attached'],
		['is:sent', 'sent by you'],
		['after:2026-08', 'on or after a day, month or year'],
		['before:2026-09-03', 'before it']
	];
	const EXAMPLES = [
		'from:okafor has:attachment',
		'subject:invoice after:2026',
		'"board deck" -draft'
	];

	function outside(event: MouseEvent): void {
		if (root !== null && !root.contains(event.target as Node)) open = false;
	}

	function escape(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			close();
		}
	}

	function focusout(event: FocusEvent): void {
		const to = event.relatedTarget;
		if (root !== null && !(to instanceof Node && root.contains(to))) open = false;
	}

	function pick(example: string): void {
		open = false;
		onpick(example);
	}
</script>

<svelte:window onkeydown={escape} onmousedown={outside} />

<span class="help" bind:this={root} onfocusout={focusout}>
	<button
		type="button"
		class="toggle"
		bind:this={toggle}
		aria-label="Search help"
		aria-expanded={open}
		onclick={() => (open ? close() : (open = true))}>?</button
	>
	{#if open}
		<div class="card" bind:this={card} role="dialog" aria-label="Search help" tabindex="-1">
			<p class="lead">Words match anywhere; operators narrow. Everything must match.</p>
			<dl>
				{#each SYNTAX as [form, meaning] (form)}
					<dt><code>{form}</code></dt>
					<dd>{meaning}</dd>
				{/each}
			</dl>
			<p class="lead">Try one:</p>
			<ul>
				{#each EXAMPLES as example (example)}
					<li>
						<button type="button" class="example" onclick={() => pick(example)}>{example}</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</span>

<style>
	.help {
		display: inline-flex;
		position: relative;
	}

	.toggle {
		all: unset;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: 1px solid var(--border);
		border-radius: 50%;
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		color: var(--text-faint);
		cursor: pointer;
	}

	.toggle:hover,
	.toggle[aria-expanded='true'] {
		border-color: var(--border-strong);
		color: var(--text-body);
	}

	.toggle:focus-visible {
		box-shadow: var(--focus-ring);
	}

	.card:focus {
		outline: 0;
	}

	.card {
		position: absolute;
		top: calc(100% + 10px);
		right: -10px;
		z-index: 20;
		width: min(400px, calc(100vw - 32px));
		padding: var(--space-4);
		background: var(--surface-page);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pop);
		font: var(--body-sm) / var(--body-leading) var(--font-body);
		color: var(--text-body);
	}

	.lead {
		margin: 0 0 var(--space-2);
		color: var(--text-muted);
	}

	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 4px 12px;
		margin: 0 0 var(--space-4);
	}

	dt,
	dd {
		margin: 0;
	}

	code {
		font: var(--mono-md) var(--font-mono);
		white-space: nowrap;
	}

	ul {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.example {
		all: unset;
		padding: 2px 7px;
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		font: var(--mono-sm) / 1.6 var(--font-mono);
		cursor: pointer;
	}

	.example:hover {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.example:focus-visible {
		box-shadow: var(--focus-ring);
	}
</style>
