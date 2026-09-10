<!--
  Settings: the own addresses, the credentials, the archive's figures and
  what this device holds and looks like. Every change goes through the account layer; the
  screen only decides what to show for each outcome. A locked session
  belongs to Unlock, which comes back here. A regenerated recovery key
  lives in the onboarding state until it is confirmed stored, so moving
  around the app does not lose it; a lock forgets it.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ApiError } from '$lib/api/types';
	import {
		LockedError,
		RateLimitedError,
		ServerUnreachableError,
		SessionExpiredError,
		WrongPassphraseError
	} from '$lib/account/errors';
	import { exportArchive } from '$lib/account/export';
	import { RebuildBlockedError, rebuildIndex } from '$lib/account/rebuild';
	import { changePassphrase, regenerateRecoveryKey } from '$lib/account/rotate';
	import { saveSettings } from '$lib/account/settings';
	import { checkForSegments } from '$lib/account/sync';
	import {
		findUnreferenced,
		IndexIncompleteError,
		unreferencedListing
	} from '$lib/account/unreferenced';
	import { saveFile } from '$lib/app/files';
	import { count, fileSize } from '$lib/app/format';
	import { isLeaving, leave, lockArchive } from '$lib/app/lock';
	import { workerParser } from '$lib/import/parser';
	import { unlockUrl } from '$lib/app/navigation';
	import { blobCache } from '$lib/cache/blobs';
	import {
		AddressList,
		Button,
		Checkbox,
		Notice,
		PassphraseChangeForm,
		PassphraseConfirmForm,
		RecoveryKeyPanel,
		SettingRow,
		SettingsSection,
		StatTiles,
		ThemePicker
	} from '$lib/components';
	import { PassphraseTooLongError, PassphraseTooShortError } from '$lib/crypto/kdf';
	import { archive } from '$lib/state/archive.svelte';
	import { exportState } from '$lib/state/export.svelte';
	import { importState } from '$lib/state/import.svelte';
	import { index } from '$lib/state/index.svelte';
	import { onboarding } from '$lib/state/onboarding.svelte';
	import { rebuildState } from '$lib/state/rebuild.svelte';
	import { session } from '$lib/state/session.svelte';
	import { theme } from '$lib/state/theme.svelte';
	import { toasts } from '$lib/state/toasts.svelte';

	const HERE = '/settings';
	const unlocked = $derived(session.status === 'unlocked');
	const stored = $derived(session.manifest?.body.settings.ownAddresses ?? []);

	$effect(() => {
		if (unlocked || archive.health === null || isLeaving()) return;
		if (!archive.health.setup) void goto(resolve('/setup'), { replaceState: true });
		else void goto(unlockUrl(HERE), { replaceState: true });
	});

	// Own addresses: edited here, compared against the manifest to know
	// whether there is anything to save.
	let addresses = $derived([...stored]);
	let list = $state<AddressList | null>(null);
	const changed = $derived(addresses.join('\n') !== stored.join('\n'));

	// Which security setting is unfolded. The phrase a regeneration produced
	// is shown until the user says it is stored; a reload would lose it, so
	// the browser asks first.
	let open = $state<'passphrase' | 'recovery' | null>(null);
	const phrase = $derived(onboarding.recoveryPhrase);
	let phraseStored = $state(false);

	$effect(() => {
		if (phrase === null) return;
		const guard = (event: BeforeUnloadEvent): void => event.preventDefault();
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	});

	let working = $state<
		| 'addresses'
		| 'passphrase'
		| 'recovery'
		| 'export'
		| 'rebuild'
		| 'unreferenced'
		| 'cache'
		| 'lock'
		| null
	>(null);
	let refused = $state<string | null>(null);
	let problem = $state<{ where: string; text: string } | null>(null);

	// Measured on arrival and again when an import or a rebuild, which
	// write to the cache, has finished.
	let cached = $state<number | null | undefined>(undefined);
	$effect(() => {
		if (!importState.active && !rebuildState.active) void measure();
	});

	async function measure(): Promise<void> {
		cached = await blobCache.size();
	}

	const stats = $derived([
		{ label: 'Messages', value: index.messages.toLocaleString() },
		{ label: 'Threads', value: index.threads.length.toLocaleString() },
		{ label: 'Storage', value: fileSize(index.bytes) },
		{ label: 'Segments', value: (session.manifest?.body.segments.length ?? 0).toLocaleString() }
	]);
	const cacheDetail = $derived(
		cached === undefined
			? 'measuring…'
			: cached === null
				? 'size unknown · index is re-downloaded on next unlock'
				: `${fileSize(cached)} · index is re-downloaded on next unlock`
	);

	/**
	 * Runs one change and turns its failure into what the screen says. A
	 * refused passphrase is reported at the field; a session the server no
	 * longer holds leaves for Unlock, one locked meanwhile is already on
	 * its way there; a manifest written by another device is adopted so
	 * that the next attempt starts from it; the rest is a notice by the
	 * setting.
	 */
	async function run(where: typeof working & string, action: () => Promise<void>): Promise<void> {
		working = where;
		refused = null;
		problem = null;
		try {
			await action();
		} catch (e) {
			if (e instanceof SessionExpiredError) {
				await leave(HERE, 'expired');
				return;
			}
			if (e instanceof LockedError) return;
			if (
				e instanceof WrongPassphraseError ||
				e instanceof PassphraseTooShortError ||
				e instanceof PassphraseTooLongError
			) {
				refused = 'Wrong passphrase';
			} else if (e instanceof RateLimitedError) {
				refused = 'Too many attempts. Wait a minute, then try again.';
			} else if (e instanceof RebuildBlockedError || e instanceof IndexIncompleteError) {
				problem = {
					where,
					text: `Not now: ${e.message.replace(/^cannot rebuild the index: /, '')}`
				};
			} else if (e instanceof ServerUnreachableError) {
				problem = { where, text: 'The server cannot be reached — try again' };
			} else if (e instanceof ApiError && e.code === 'conflict') {
				await checkForSegments().catch(() => {});
				problem = {
					where,
					text: 'The archive was changed on another device and has been reloaded — try again'
				};
			} else {
				problem = { where, text: 'Something went wrong — try again' };
			}
		} finally {
			working = null;
		}
	}

	function saveAddresses(): Promise<void> {
		if (list !== null && !list.add() && list.hasDraft()) return Promise.resolve();
		return run('addresses', async () => {
			await saveSettings({ ownAddresses: addresses });
			toasts.push({ tone: 'ok', label: 'saved', message: 'Own addresses saved.' });
		});
	}

	function unfold(what: 'passphrase' | 'recovery'): void {
		open = open === what ? null : what;
		refused = null;
		problem = null;
	}

	function changeIt(current: string, next: string): Promise<void> {
		return run('passphrase', async () => {
			await changePassphrase(current, next);
			open = null;
			toasts.push({
				tone: 'ok',
				label: 'done',
				message: 'Passphrase changed. Other devices have been signed out.'
			});
		});
	}

	function regenerate(current: string): Promise<void> {
		return run('recovery', async () => {
			const { recoveryPhrase } = await regenerateRecoveryKey(current);
			phraseStored = false;
			onboarding.recoveryPhrase = recoveryPhrase;
		});
	}

	function forgetPhrase(): void {
		onboarding.takeRecoveryPhrase();
		phraseStored = false;
		open = null;
	}

	// Writing files into a folder the user picks is the File System Access
	// API, which not every browser has; the row says so where it is missing.
	const canExport = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
	let exporting = $state<AbortController | null>(null);
	const exportDetail = $derived.by(() => {
		if (!canExport)
			return 'not available in this browser · Chrome or Edge on a computer can write into a folder';
		if (exportState.active)
			return `${exportState.done.toLocaleString()} of ${exportState.total.toLocaleString()} written`;
		if (exportState.status === 'idle') return 'one .eml file per message, into a folder you choose';
		const written = count(exportState.done - exportState.failed, 'message');
		const failed =
			exportState.failed === 0 ? '' : `, ${count(exportState.failed, 'message')} skipped`;
		return exportState.status === 'cancelled'
			? `stopped after ${written}${failed}`
			: `${written} written${failed}`;
	});

	async function exportAll(): Promise<void> {
		// The picker must follow the click directly, before any await.
		let folder: FileSystemDirectoryHandle;
		try {
			folder = await window.showDirectoryPicker({ mode: 'readwrite' });
		} catch {
			return; // Dismissed, or refused: nothing to do.
		}
		const controller = new AbortController();
		exporting = controller;
		try {
			await run('export', async () => {
				const summary = await exportArchive(folder, { signal: controller.signal });
				if (!summary.cancelled) {
					toasts.push({
						tone: summary.failed === 0 ? 'ok' : 'accent',
						label: 'exported',
						message: `${count(summary.written, 'message')} written to ${folder.name}.`
					});
				}
			});
		} finally {
			exporting = null;
		}
	}

	// A rebuild parses every original again with the code as it is now and
	// replaces the segments; an import at the same time would write into
	// the list being replaced, so the row waits for it.
	let rebuilding = $state<AbortController | null>(null);
	const rebuildDetail = $derived.by(() => {
		if (importState.active) return 'waits for the import to finish';
		if (rebuildState.status === 'committing') {
			return rebuildState.writing === null
				? 'writing the manifest'
				: `writing segment, ${rebuildState.writing.done} of ${rebuildState.writing.total} blobs`;
		}
		if (rebuildState.active) {
			return `${rebuildState.done.toLocaleString()} of ${rebuildState.total.toLocaleString()} parsed`;
		}
		if (rebuildState.status === 'idle') {
			return 'parses every message again with the current version · nothing is re-uploaded';
		}
		if (rebuildState.status === 'cancelled') return 'stopped · the archive is as it was';
		if (rebuildState.error !== null) return 'failed · the archive is as it was';
		const kept =
			rebuildState.kept === 0 ? '' : `, ${count(rebuildState.kept, 'record')} kept as before`;
		return `${count(rebuildState.done - rebuildState.kept, 'message')} rebuilt${kept}`;
	});

	async function rebuildAll(): Promise<void> {
		const controller = new AbortController();
		rebuilding = controller;
		try {
			await run('rebuild', async () => {
				const summary = await rebuildIndex({ parser: workerParser(), signal: controller.signal });
				unreferenced = null;
				if (!summary.cancelled) {
					toasts.push({
						tone: summary.kept === 0 ? 'ok' : 'accent',
						label: 'rebuilt',
						message: `Index rebuilt from ${count(summary.rebuilt, 'message')}.`
					});
				}
			});
		} finally {
			rebuilding = null;
		}
	}

	// What the server stores that nothing points to. Nothing here deletes:
	// the server has no such route, so the admin removes the listed files.
	let unreferenced = $state<string[] | null>(null);
	const unreferencedDetail = $derived.by(() => {
		if (unreferenced === null)
			return "blobs the archive no longer points to, for the server's admin to remove";
		if (unreferenced.length === 0) return 'nothing to remove';
		return `${count(unreferenced.length, 'blob')} · paths are relative to the data directory · remove them only while no import runs anywhere`;
	});

	function checkUnreferenced(): Promise<void> {
		return run('unreferenced', async () => {
			unreferenced = await findUnreferenced();
		});
	}

	function downloadUnreferenced(): void {
		if (unreferenced === null) return;
		saveFile(
			'unreferenced.txt',
			new TextEncoder().encode(unreferencedListing(unreferenced)),
			'text/plain'
		);
	}

	function clearCache(): Promise<void> {
		return run('cache', async () => {
			await blobCache.clear();
			await measure();
			toasts.push({ tone: 'ok', label: 'done', message: 'Cache cleared on this device.' });
		});
	}

	function lockNow(): Promise<void> {
		return run('lock', () => lockArchive(HERE));
	}
</script>

<svelte:head><title>Settings · mailarchive</title></svelte:head>

{#if unlocked}
	<div class="settings">
		<h1>Settings</h1>

		<SettingsSection title="Own addresses">
			<div class="addresses">
				<AddressList bind:this={list} bind:addresses disabled={working === 'addresses'} />
				<p class="hint">
					Mail from these addresses is labelled sent and lists show “to X” instead of your own name.
					A * stands for anything, so *@icloud.com covers every alias.
				</p>
				<div class="save">
					<Button
						variant="secondary"
						size="sm"
						onclick={saveAddresses}
						busy={working === 'addresses'}
						disabled={!changed}>Save</Button
					>
				</div>
				{#if problem?.where === 'addresses'}<Notice>{problem.text}</Notice>{/if}
			</div>
		</SettingsSection>

		<SettingsSection title="Security">
			<SettingRow
				title="Change passphrase"
				detail="signs out every other device"
				open={open === 'passphrase'}
			>
				{#snippet action()}
					<Button
						variant="secondary"
						size="sm"
						onclick={() => unfold('passphrase')}
						aria-expanded={open === 'passphrase'}
						disabled={working !== null}>Change</Button
					>
				{/snippet}
				{#if open === 'passphrase'}
					<PassphraseChangeForm
						busy={working === 'passphrase'}
						error={refused}
						onsubmit={changeIt}
						oncancel={() => unfold('passphrase')}
					/>
					{#if problem?.where === 'passphrase'}<Notice>{problem.text}</Notice>{/if}
				{/if}
			</SettingRow>
			<SettingRow
				title="Regenerate recovery key"
				detail="invalidates the current key"
				open={phrase !== null || open === 'recovery'}
			>
				{#snippet action()}
					<Button
						variant="secondary"
						size="sm"
						onclick={() => unfold('recovery')}
						aria-expanded={phrase !== null || open === 'recovery'}
						disabled={phrase !== null || working !== null}>Regenerate</Button
					>
				{/snippet}
				{#if phrase !== null}
					<p class="lead">
						Shown once. If you lose both your passphrase and this key, the archive cannot be opened
						by anyone.
					</p>
					<RecoveryKeyPanel {phrase} />
					<Checkbox bind:checked={phraseStored} name="stored">
						I have stored this key somewhere safe, outside this device.
					</Checkbox>
					<div class="save">
						<Button size="sm" onclick={forgetPhrase} disabled={!phraseStored}>Done</Button>
					</div>
				{:else if open === 'recovery'}
					<PassphraseConfirmForm
						label="Regenerate"
						busy={working === 'recovery'}
						error={refused}
						onsubmit={regenerate}
						oncancel={() => unfold('recovery')}
					/>
					{#if problem?.where === 'recovery'}<Notice>{problem.text}</Notice>{/if}
				{/if}
			</SettingRow>
		</SettingsSection>

		<SettingsSection title="Archive">
			<StatTiles {stats} />
			{#if index.loading !== null}
				<p class="hint">
					Decrypting index, {count(index.loading.done, 'segment')} of {index.loading.total} so far.
				</p>
			{/if}
			<SettingRow
				title="Export as .eml files"
				detail={exportDetail}
				open={problem?.where === 'export' || exportState.skipped.length > 0}
			>
				{#snippet action()}
					{#if exporting !== null}
						<Button variant="secondary" size="sm" onclick={() => exporting?.abort()}>Stop</Button>
					{:else}
						<Button
							variant="secondary"
							size="sm"
							onclick={exportAll}
							disabled={!canExport || index.messages === 0 || working !== null}>Export…</Button
						>
					{/if}
				{/snippet}
				{#if problem?.where === 'export'}<Notice>{problem.text}</Notice>{/if}
				{#if exportState.skipped.length > 0}
					<section class="log" aria-label="Export log">
						<h3>Export log</h3>
						<ul>
							{#each exportState.skipped as skip, i (i)}
								<li>
									<span class="what"
										>{skip.subject.trim() === '' ? '(no subject)' : skip.subject}</span
									>
									<span class="why">{skip.reason}</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</SettingRow>
			<SettingRow title="Rebuild index" detail={rebuildDetail} open={problem?.where === 'rebuild'}>
				{#snippet action()}
					{#if rebuilding !== null}
						<Button variant="secondary" size="sm" onclick={() => rebuilding?.abort()}>Stop</Button>
					{:else}
						<Button
							variant="secondary"
							size="sm"
							onclick={rebuildAll}
							disabled={importState.active || index.messages === 0 || working !== null}
							>Rebuild</Button
						>
					{/if}
				{/snippet}
				{#if problem?.where === 'rebuild'}<Notice>{problem.text}</Notice>{/if}
			</SettingRow>
			<SettingRow
				title="Unreferenced data"
				detail={unreferencedDetail}
				open={problem?.where === 'unreferenced' ||
					(unreferenced !== null && unreferenced.length > 0)}
			>
				{#snippet action()}
					<Button
						variant="secondary"
						size="sm"
						onclick={checkUnreferenced}
						busy={working === 'unreferenced'}
						disabled={importState.active || rebuildState.active || working !== null}>Check</Button
					>
				{/snippet}
				{#if problem?.where === 'unreferenced'}<Notice>{problem.text}</Notice>{/if}
				{#if unreferenced !== null && unreferenced.length > 0}
					<p class="hint">
						The server keeps these files, but no segment or message points to them. Download the
						list and remove the paths from the data directory on the server.
					</p>
					<Button variant="secondary" size="sm" onclick={downloadUnreferenced}>Download list</Button
					>
				{/if}
			</SettingRow>
		</SettingsSection>

		<SettingsSection title="Appearance">
			<ThemePicker value={theme.choice} system={theme.look} onchange={(t) => theme.choose(t)} />
			<p class="hint">Kept on this device. System follows the browser between light and dark.</p>
		</SettingsSection>

		<SettingsSection title="This device">
			<SettingRow title="Clear cache" detail={cacheDetail} open={problem?.where === 'cache'}>
				{#snippet action()}
					<Button
						variant="secondary"
						size="sm"
						onclick={clearCache}
						busy={working === 'cache'}
						disabled={cached === null || working !== null}>Clear</Button
					>
				{/snippet}
				{#if problem?.where === 'cache'}<Notice>{problem.text}</Notice>{/if}
			</SettingRow>
			<SettingRow title="Lock now" detail="drops keys from memory">
				{#snippet action()}
					<Button size="sm" onclick={lockNow} busy={working === 'lock'} disabled={working !== null}
						>Lock</Button
					>
				{/snippet}
			</SettingRow>
		</SettingsSection>
	</div>
{:else if archive.error !== null}
	<p class="status">The archive is unreachable.</p>
{:else}
	<p class="status">Loading…</p>
{/if}

<style>
	.status {
		margin: auto;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}

	.settings {
		width: 100%;
		max-width: 800px;
		margin: 0 auto;
		padding: 40px 0 var(--space-7);
		display: flex;
		flex-direction: column;
		gap: 36px;
	}

	h1 {
		margin: 0;
		font: 500 var(--mono-2xl) / 1.2 var(--font-mono);
	}

	.addresses {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		max-width: 440px;
	}

	.hint,
	.lead {
		margin: 0;
		font: var(--body-sm) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}

	.log {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.log h3 {
		margin: 0;
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.log ul {
		margin: 0;
		padding: 0 0 var(--space-2);
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-x: auto;
	}

	.log li {
		display: flex;
		gap: var(--space-3);
		font: var(--mono-md) var(--font-mono);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.what {
		flex: none;
		max-width: 40ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.why {
		color: var(--danger-ink);
		white-space: nowrap;
	}

	.save {
		display: flex;
		justify-content: flex-end;
	}
</style>
