<!--
  Where an import starts: a dashed target that takes dropped files or
  folders, and pickers for either. Reports what was chosen already
  filtered to .eml files; the caller starts the run.
-->
<script lang="ts">
	import { fromDataTransfer, fromFileList, type ImportFile } from '$lib/import/sources';
	import Button from './Button.svelte';
	import Code from './Code.svelte';

	interface Props {
		onfiles: (files: ImportFile[]) => void;
		disabled?: boolean;
	}

	let { onfiles, disabled = false }: Props = $props();
	let over = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);

	async function drop(event: DragEvent): Promise<void> {
		event.preventDefault();
		over = false;
		if (disabled || event.dataTransfer === null) return;
		onfiles(await fromDataTransfer(event.dataTransfer));
	}

	function picked(input: HTMLInputElement): void {
		if (input.files !== null) onfiles(fromFileList(input.files));
		input.value = '';
	}
</script>

<div
	class="zone"
	class:over
	class:disabled
	role="group"
	aria-label="Import files"
	ondragover={(e) => {
		e.preventDefault();
		if (!disabled) over = true;
	}}
	ondragleave={() => (over = false)}
	ondrop={drop}
>
	<p>Drop <Code>.eml</Code> files or a folder here</p>
	<div class="actions">
		<Button variant="secondary" size="sm" {disabled} onclick={() => folderInput?.click()}>
			Choose folder
		</Button>
		<Button variant="ghost" size="sm" {disabled} onclick={() => fileInput?.click()}>
			Choose files
		</Button>
	</div>
	<input
		bind:this={fileInput}
		type="file"
		accept=".eml,message/rfc822"
		multiple
		hidden
		data-testid="file-input"
		onchange={(e) => picked(e.currentTarget)}
	/>
	<input
		bind:this={folderInput}
		type="file"
		webkitdirectory
		multiple
		hidden
		data-testid="folder-input"
		onchange={(e) => picked(e.currentTarget)}
	/>
</div>

<style>
	.zone {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: 20px;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-md);
		background: var(--surface-page);
	}

	.over {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.disabled {
		opacity: 0.5;
	}

	p {
		margin: 0;
		font: var(--body-md) / var(--body-leading) var(--font-body);
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}
</style>
