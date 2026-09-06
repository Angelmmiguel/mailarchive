<!--
  The 24-word recovery phrase, with copy and download. Both are local to
  this component: the clipboard write and the generated text file never go
  through any other layer, and the phrase is never logged.
-->
<script lang="ts">
	import Button from './Button.svelte';

	interface Props {
		phrase: string;
		/** Name of the downloaded file. */
		filename?: string;
	}

	let { phrase, filename = 'mailarchive-recovery-key.txt' }: Props = $props();

	const words = $derived(phrase.split(' '));
	let copied = $state(false);
	let copyFailed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy(): Promise<void> {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(phrase);
			copied = true;
			copyFailed = false;
		} catch {
			copied = false;
			copyFailed = true;
		}
		timer = setTimeout(() => {
			copied = false;
			copyFailed = false;
		}, 2000);
	}

	function download(): void {
		const text = `mailarchive recovery key\n\n${words.map((w, i) => `${String(i + 1).padStart(2)}. ${w}`).join('\n')}\n\nKeep this file outside the device that holds the archive.\n`;
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="panel">
	<ol class="words" data-testid="recovery-phrase">
		{#each words as word, i (i)}
			<li><span class="index">{i + 1}</span>{word}</li>
		{/each}
	</ol>
	<div class="actions">
		<Button variant="secondary" size="sm" onclick={copy}>
			{copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy'}
		</Button>
		<Button variant="secondary" size="sm" onclick={download}><span>↓</span>Download .txt</Button>
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-md);
		background: var(--surface-panel);
	}

	.words {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		column-gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		font: 500 var(--mono-lg) / 1.7 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		user-select: all;
	}

	.words li {
		display: flex;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.index {
		width: 2ch;
		flex: none;
		text-align: right;
		font-weight: 400;
		color: var(--text-faint);
		user-select: none;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
	}
</style>
