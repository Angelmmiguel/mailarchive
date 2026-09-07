<!--
  An attachment as a chip: the kind, the name, the size and what a click
  does with it. The click hands the part to the screen, which fetches
  and decrypts the original; the chip shows it is working meanwhile.
-->
<script lang="ts">
	import { fileKind, fileSize, opensInTab } from '$lib/app/format';
	import type { AttachmentMeta } from '$lib/mail/message';

	interface Props {
		attachment: AttachmentMeta;
		busy?: boolean;
		onclick: () => void;
	}

	let { attachment, busy = false, onclick }: Props = $props();
	const hint = $derived(opensInTab(attachment.type) ? 'opens in new tab' : 'download');
</script>

<button type="button" class="chip" {onclick} disabled={busy} aria-busy={busy || undefined}>
	<span class="kind">{fileKind(attachment.name, attachment.type)}</span>
	<span class="text">
		<span class="name">{attachment.name}</span>
		<span class="detail">{fileSize(attachment.size)} · {busy ? 'decrypting…' : hint}</span>
	</span>
</button>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		height: 36px;
		max-width: 100%;
		padding: 0 10px 0 6px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.chip:hover:not(:disabled) {
		background: var(--surface-inset);
	}

	.chip:disabled {
		cursor: progress;
	}

	.kind {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 24px;
		min-width: 30px;
		padding: 0 4px;
		border-radius: 2px;
		background: var(--surface-ink);
		color: var(--text-on-ink);
		font: 500 var(--mono-xs) var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		flex: none;
	}

	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.2;
	}

	.name {
		font: var(--body-sm) var(--font-body);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail {
		font: var(--mono-xs) var(--font-mono);
		color: var(--text-faint);
	}
</style>
