<!--
  One thread beside the list, named in the address by its opaque key.
  The reader gets what it needs from the account layer through the
  callbacks here: a message's view, its original, an attachment.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { ResolvedPathname } from '$app/types';
	import {
		openAttachment,
		openInlineImages,
		openMessage,
		openOriginal
	} from '$lib/account/messages';
	import { openFile, saveFile } from '$lib/app/files';
	import { opensInTab } from '$lib/app/format';
	import { EmptyState, ThreadReader } from '$lib/components';
	import type { IndexRecord } from '$lib/index/records';
	import { THREAD_KEY, type Thread } from '$lib/index/threads';
	import type { AttachmentMeta } from '$lib/mail/message';
	import { session } from '$lib/state/session.svelte';
	import { view } from '$lib/state/view.svelte';

	const key = $derived(page.params.key ?? '');
	const thread = $derived(THREAD_KEY.test(key) ? view.threadFor(key) : null);
	const own = $derived(session.manifest?.body.settings.ownAddresses ?? []);
	const at = $derived(thread === null ? -1 : view.listing.findIndex((t) => t.id === thread.id));
	// `ResolvedPathname` does not model a query string, hence the casts.
	const archiveHref = $derived(`${resolve('/')}${page.url.search}` as ResolvedPathname);

	function hrefFor(neighbour: Thread | undefined): ResolvedPathname | null {
		if (neighbour === undefined) return null;
		const path = resolve('/(archive)/t/[key]', { key: view.keyFor(neighbour.id) });
		return `${path}${page.url.search}` as ResolvedPathname;
	}

	function fileName(record: IndexRecord): string {
		const base = (record.subject || 'message').slice(0, 80);
		return `${base}.eml`;
	}

	async function download(record: IndexRecord): Promise<void> {
		saveFile(fileName(record), await openOriginal(record), 'message/rfc822');
	}

	async function source(record: IndexRecord): Promise<string> {
		return new TextDecoder().decode(await openOriginal(record));
	}

	async function attachment(record: IndexRecord, meta: AttachmentMeta): Promise<void> {
		const file = await openAttachment(record, meta);
		if (opensInTab(file.type)) openFile(file.bytes, file.type);
		else saveFile(file.name, file.bytes, file.type);
	}
</script>

<svelte:head><title>{thread?.subject ?? 'Thread'} · mailarchive</title></svelte:head>

{#if thread === null}
	<EmptyState title="Thread not found">
		Nothing in this archive has that address. It may have been imported on another device after this
		one unlocked, or the link may be from a different archive.
		{#snippet actions()}
			<a href={archiveHref}>Back to the archive</a>
		{/snippet}
	</EmptyState>
{:else}
	<ThreadReader
		{thread}
		{own}
		position={at === -1 ? null : at + 1}
		total={view.listing.length}
		{archiveHref}
		prevHref={hrefFor(at > 0 ? view.listing[at - 1] : undefined)}
		nextHref={hrefFor(at === -1 ? undefined : view.listing[at + 1])}
		onopen={(record) => openMessage(record)}
		ondownload={download}
		oninline={(record) => openInlineImages(record)}
		onsource={source}
		onattachment={attachment}
	/>
{/if}
