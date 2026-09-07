<!--
  One setting: what it does, a mono detail under it, and its action on the
  right. Whatever a setting unfolds into (a form, a key) renders below
  while `open`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		detail?: string;
		/** Whether the body is shown. */
		open?: boolean;
		action: Snippet;
		children?: Snippet;
	}

	let { title, detail, open = false, action, children }: Props = $props();
</script>

<div class="row">
	<div class="head">
		<span class="title">
			{title}
			{#if detail !== undefined}<span class="detail">{detail}</span>{/if}
		</span>
		{@render action()}
	</div>
	{#if open && children}
		<div class="body">{@render children()}</div>
	{/if}
</div>

<style>
	.row {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 440px;
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-4);
	}

	.title {
		font: var(--body-md) / 1.5 var(--font-body);
	}

	.detail {
		display: block;
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		border: var(--hairline);
	}
</style>
