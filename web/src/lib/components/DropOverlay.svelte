<!--
  Makes the whole page a drop target. Shows a veil while files are dragged
  over the window and hands what is dropped to the caller.
-->
<script lang="ts">
	import { fromDataTransfer, type ImportFile } from '$lib/import/sources';
	import Code from './Code.svelte';

	interface Props {
		onfiles: (files: ImportFile[]) => void;
	}

	let { onfiles }: Props = $props();
	let depth = $state(0);

	function hasFiles(event: DragEvent): boolean {
		return Array.from(event.dataTransfer?.types ?? []).includes('Files');
	}

	function enter(event: DragEvent): void {
		if (!hasFiles(event)) return;
		event.preventDefault();
		depth++;
	}

	function leave(event: DragEvent): void {
		if (!hasFiles(event)) return;
		depth = Math.max(0, depth - 1);
	}

	function over(event: DragEvent): void {
		if (hasFiles(event)) event.preventDefault();
	}

	async function drop(event: DragEvent): Promise<void> {
		depth = 0;
		// The panel's own zone handles its drops first.
		if (event.defaultPrevented || !hasFiles(event) || event.dataTransfer === null) return;
		event.preventDefault();
		onfiles(await fromDataTransfer(event.dataTransfer));
	}

	// A drag abandoned outside the window never sends dragleave.
	function reset(): void {
		depth = 0;
	}
</script>

<svelte:window
	ondragenter={enter}
	ondragleave={leave}
	ondragover={over}
	ondrop={drop}
	ondragend={reset}
	onblur={reset}
/>

{#if depth > 0}
	<div class="veil" aria-hidden="true">
		<p>Drop <Code>.eml</Code> files or a folder to import them</p>
	</div>
{/if}

<style>
	.veil {
		position: fixed;
		inset: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--accent-soft);
		border: 2px dashed var(--accent);
		pointer-events: none;
	}

	p {
		margin: 0;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		background: var(--surface-page);
		box-shadow: var(--shadow-pop);
		font: var(--body-md) / var(--body-leading) var(--font-body);
	}
</style>
