<!--
  A one-line status at the foot of a screen: a tag with the kind of notice
  and the message, which may carry a link. Announced to screen readers.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Tag from './Tag.svelte';

	interface Props {
		tone?: 'neutral' | 'accent' | 'ok' | 'danger';
		label?: string;
		children: Snippet;
	}

	let { tone = 'danger', label = tone === 'danger' ? 'error' : tone, children }: Props = $props();
</script>

<div class="notice {tone}" role={tone === 'danger' ? 'alert' : 'status'}>
	<Tag {tone}>{label}</Tag>
	<span>{@render children()}</span>
</div>

<style>
	.notice {
		display: flex;
		gap: 10px;
		align-items: center;
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		color: var(--text-muted);
	}

	.danger {
		color: var(--danger-ink);
	}

	.ok {
		color: var(--ok-ink);
	}
</style>
