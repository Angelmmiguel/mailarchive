<!--
  One message opened in a thread: the headers, the body as text or as
  sanitized HTML, the original to download or read as source, and the
  attachments as chips. Fetching is the screen's; this owns the toggles
  and the working states. Images show only while the thread asks for them:
  remote ones straight from their source, embedded ones from the raw blob.
-->
<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { longDate } from '$lib/app/format';
	import type { AttachmentFile } from '$lib/account/messages';
	import type { MessageView } from '$lib/import/prepare';
	import type { IndexRecord } from '$lib/index/records';
	import type { Address, AttachmentMeta } from '$lib/mail/message';
	import { imagesFrom, sanitizeHtml } from '$lib/mail/sanitize';
	import AttachmentChip from './AttachmentChip.svelte';
	import Button from './Button.svelte';
	import HtmlBody from './HtmlBody.svelte';
	import Notice from './Notice.svelte';

	interface Props {
		record: IndexRecord;
		/** Null while the view is being fetched. */
		message: MessageView | null;
		error: string | null;
		/** Whether images may load right now. */
		images?: boolean;
		ondownload: () => Promise<void>;
		/** The parts the HTML embeds by content id. */
		oninline: () => Promise<Map<string, AttachmentFile>>;
		onsource: () => Promise<string>;
		onattachment: (attachment: AttachmentMeta) => Promise<void>;
	}

	let {
		record,
		message,
		error,
		images = false,
		ondownload,
		oninline,
		onsource,
		onattachment
	}: Props = $props();

	// Asking for images is asking to see the HTML; the toggle still works.
	let mode = $derived<'text' | 'html'>(images && message?.html ? 'html' : 'text');
	// Object URLs for the embedded parts, made when images are first asked
	// for and revoked with the card.
	let inline = $state<SvelteMap<string, string> | null>(null);
	const wantsInline = $derived(images && /cid:/i.test(message?.html ?? ''));

	$effect(() => {
		if (!wantsInline || inline !== null) return;
		const urls = new SvelteMap<string, string>();
		inline = urls;
		void oninline().then(
			(parts) => {
				for (const [id, part] of parts) {
					urls.set(
						id,
						URL.createObjectURL(new Blob([part.bytes as BlobPart], { type: part.type }))
					);
				}
			},
			(e: unknown) => (problem = e instanceof Error ? e.message : String(e))
		);
		return () => {
			for (const url of urls.values()) URL.revokeObjectURL(url);
		};
	});
	let source = $state<string | null>(null);
	let showSource = $state(false);
	let working = $state<string | null>(null);
	let problem = $state<string | null>(null);

	const html = $derived(
		message?.html === null || message === null
			? null
			: sanitizeHtml(message.html, images ? imagesFrom(inline ?? new Map()) : null)
	);
	const files = $derived(record.attachments.filter((a) => !a.inline));

	function mailbox(address: Address): string {
		return address.name === '' ? address.address : `${address.name} <${address.address}>`;
	}

	async function run(what: string, action: () => Promise<void>): Promise<void> {
		working = what;
		problem = null;
		try {
			await action();
		} catch (e) {
			problem = e instanceof Error ? e.message : String(e);
		} finally {
			working = null;
		}
	}

	function toggleSource(): void {
		if (showSource) {
			showSource = false;
			return;
		}
		if (source !== null) {
			showSource = true;
			return;
		}
		void run('source', async () => {
			source = await onsource();
			showSource = true;
		});
	}
</script>

<article class="message" data-testid="message">
	<div class="head">
		<dl class="headers">
			<dt>From</dt>
			<dd>{record.from === null ? 'unknown' : mailbox(record.from)}</dd>
			{#if record.to.length > 0}
				<dt>To</dt>
				<dd>{record.to.map(mailbox).join(', ')}</dd>
			{/if}
			{#if record.cc.length > 0}
				<dt>Cc</dt>
				<dd>{record.cc.map(mailbox).join(', ')}</dd>
			{/if}
			<dt>Date</dt>
			<dd>{longDate(record.date)}</dd>
		</dl>
		<div class="tools">
			{#if html !== null}
				<div class="modes" role="group" aria-label="Body format">
					<button type="button" class:on={mode === 'text'} onclick={() => (mode = 'text')}
						>Text</button
					>
					<button type="button" class:on={mode === 'html'} onclick={() => (mode = 'html')}
						>HTML</button
					>
				</div>
			{/if}
			<div class="actions">
				<Button
					variant="ghost"
					size="sm"
					busy={working === 'download'}
					onclick={() => run('download', ondownload)}>↓ .eml</Button
				>
				<Button
					variant="ghost"
					size="sm"
					busy={working === 'source'}
					aria-pressed={showSource}
					onclick={toggleSource}>Source</Button
				>
			</div>
		</div>
	</div>

	{#if problem !== null}
		<Notice>{problem}</Notice>
	{/if}

	{#if showSource && source !== null}
		<pre class="source" data-testid="source">{source}</pre>
	{:else if error !== null}
		<Notice>{error}</Notice>
	{:else if message === null}
		<p class="loading">Decrypting…</p>
	{:else if mode === 'html' && html !== null}
		<HtmlBody {html} />
	{:else}
		<div class="text" data-testid="text-body">{message.text}</div>
	{/if}

	{#if files.length > 0}
		<div class="files">
			{#each files as attachment (attachment.index)}
				<AttachmentChip
					{attachment}
					busy={working === `file-${attachment.index}`}
					onclick={() => run(`file-${attachment.index}`, () => onattachment(attachment))}
				/>
			{/each}
		</div>
	{/if}
</article>

<style>
	.message {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4) 0 var(--space-5);
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.headers {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr);
		gap: 4px 12px;
		align-items: baseline;
		margin: 0;
		min-width: 0;
	}

	dt {
		font: var(--mono-sm) / 1.5 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	dd {
		margin: 0;
		font: var(--body-md) / 1.5 var(--font-body);
		overflow-wrap: anywhere;
	}

	.tools {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.modes {
		display: inline-flex;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.modes button {
		height: 24px;
		padding: 0 10px;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	.modes .on {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.actions {
		display: flex;
		gap: var(--space-1);
	}

	.loading {
		margin: 0;
		font: var(--body-md) var(--font-body);
		color: var(--text-muted);
	}

	.text {
		max-width: var(--reading-measure);
		font: var(--body-lg) / var(--reading-leading) var(--font-body);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.source {
		margin: 0;
		padding: var(--space-3);
		max-height: 60vh;
		overflow: auto;
		border: var(--hairline);
		border-radius: var(--radius-sm);
		background: var(--surface-inset);
		font: var(--mono-sm) / var(--mono-leading) var(--font-mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.files {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
</style>
