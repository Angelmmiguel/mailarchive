<!--
  One message opened in a thread: the headers under a bar that chooses the
  view, the original to download, and the attachments as chips. Fetching is
  the screen's; this owns the choice and the working states. HTML is the
  view when the message has it. Images show only while the thread asks for
  them: remote ones straight from their source, embedded ones from the raw
  blob. A decryption slow enough to notice shows a spinner; a fast one
  shows nothing before the view arrives.
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

	type Mode = 'text' | 'html' | 'source';

	interface Props {
		record: IndexRecord;
		/** Null while the view is being fetched. */
		message: MessageView | null;
		error: string | null;
		/** Whether images may load right now. */
		images?: boolean;
		/** Asks the thread to load images, or to stop. */
		onimages?: (on: boolean) => void;
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
		onimages,
		ondownload,
		oninline,
		onsource,
		onattachment
	}: Props = $props();

	// The view the message arrives in, until the bar is asked for another.
	// The bar shows no choice before that: which views there are is not
	// known until the message is here, and a guess would flicker.
	let mode = $derived<Mode>(message?.html ? 'html' : 'text');
	// Object URLs for the embedded parts, made when images are first asked
	// for and revoked with the card.
	let inline = $state<SvelteMap<string, string> | null>(null);
	const wantsInline = $derived(images && /cid:/i.test(message?.html ?? ''));

	$effect(() => {
		if (!wantsInline) return;
		// Written, never read, here: reading it would make this effect its
		// own trigger.
		const urls = new SvelteMap<string, string>();
		let live = true;
		inline = urls;
		void oninline().then(
			(parts) => {
				// The card may be gone by the time the parts arrive; a URL
				// made now would have nobody to revoke it.
				if (!live) return;
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
			live = false;
			for (const url of urls.values()) URL.revokeObjectURL(url);
			inline = null;
		};
	});
	let source = $state<string | null>(null);
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

	function select(next: Mode): void {
		if (next !== 'source' || source !== null) {
			mode = next;
			return;
		}
		void run('source', async () => {
			source = await onsource();
			mode = 'source';
		});
	}
</script>

<article class="message" data-testid="message">
	{#if message !== null || error !== null}
		<div class="head">
			<div class="bar">
				<span class="legend">View</span>
				{#if message !== null}
					<div class="modes" role="group" aria-label="Body format">
						<button type="button" class:on={mode === 'text'} onclick={() => select('text')}
							>Text</button
						>
						{#if html !== null}
							<button type="button" class:on={mode === 'html'} onclick={() => select('html')}
								>HTML</button
							>
						{/if}
						<button
							type="button"
							class:on={mode === 'source'}
							aria-busy={working === 'source'}
							onclick={() => select('source')}>Source</button
						>
					</div>
				{/if}
				{#if html !== null && onimages !== undefined}
					<i class="divider"></i>
					<button
						type="button"
						class="images"
						aria-pressed={images}
						onclick={() => onimages(!images)}
					>
						<span class="track"><i class="knob"></i></span>Images
					</button>
				{/if}
				<div class="download">
					<Button
						variant="ghost"
						size="sm"
						busy={working === 'download'}
						onclick={() => run('download', ondownload)}>↓ .eml</Button
					>
				</div>
			</div>
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
		</div>
	{/if}

	{#if problem !== null}
		<Notice>{problem}</Notice>
	{/if}

	<div class="body" class:ready={message !== null || error !== null}>
		{#if mode === 'source' && source !== null}
			<pre class="source" data-testid="source">{source}</pre>
		{:else if error !== null}
			<Notice>{error}</Notice>
		{:else if message === null}
			<p class="loading" role="status" aria-label="Decrypting">
				<span class="spinner" aria-hidden="true"></span>
			</p>
		{:else if mode === 'html' && html !== null}
			<HtmlBody {html} />
		{:else}
			<div class="text" data-testid="text-body">{message.text}</div>
		{/if}
	</div>

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
		animation: enter 200ms ease both;
		display: flex;
		flex-direction: column;
		border: var(--hairline);
		border-radius: var(--radius-sm);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		min-height: 34px;
		padding: 0 6px 0 var(--space-3);
		border-bottom: var(--hairline);
		background: var(--surface-panel);
	}

	.legend {
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
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
		border-left: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-muted);
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	.modes button:first-child {
		border-left: 0;
	}

	.modes button:hover {
		background: var(--surface-inset);
	}

	.modes .on {
		background: var(--surface-ink);
		color: var(--text-on-ink);
	}

	.divider {
		width: 1px;
		height: 16px;
		background: var(--border-strong);
	}

	.images {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		height: var(--control-h-sm);
		padding: 0 var(--space-1);
		border: 0;
		background: transparent;
		color: var(--text-muted);
		font: 500 var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		cursor: pointer;
	}

	.images:hover {
		color: var(--text-body);
	}

	.track {
		position: relative;
		flex: none;
		width: 22px;
		height: 12px;
		border-radius: 6px;
		background: var(--border-strong);
		transition: background 150ms;
	}

	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--surface-page);
		transition: left 150ms;
	}

	.images[aria-pressed='true'] .track {
		background: var(--accent);
	}

	.images[aria-pressed='true'] .knob {
		left: 12px;
	}

	.download {
		margin-left: auto;
		flex: none;
	}

	.headers {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr);
		gap: 2px var(--space-3);
		align-items: baseline;
		margin: 0;
		min-width: 0;
		padding: var(--space-2) var(--space-3);
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

	.body.ready {
		animation: enter 200ms ease both;
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 88px;
		margin: 0;
		/* A view that is already in hand should show no waiting at all. */
		opacity: 0;
		animation: appear 150ms ease 300ms forwards;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--text-faint);
		border-right-color: transparent;
		border-radius: 50%;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes appear {
		to {
			opacity: 1;
		}
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
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

	@media (prefers-reduced-motion: reduce) {
		.head,
		.body.ready {
			animation: none;
		}

		.spinner {
			animation-duration: 2s;
		}
	}
</style>
