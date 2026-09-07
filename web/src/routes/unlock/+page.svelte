<!--
  Unlock: the passphrase, and back to wherever the user was. The URL says
  why the screen was reached (`reason`) and where to return (`next`), so
  both survive a reload. A server with no account belongs to Create
  account; an already open session goes straight through.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		MissingManifestError,
		NotSetUpError,
		RateLimitedError,
		ServerUnreachableError,
		WrongPassphraseError
	} from '$lib/account/errors';
	import { openIndex } from '$lib/account/segments';
	import { indexProblem } from '$lib/app/boot';
	import { unlock } from '$lib/account/unlock';
	import { PassphraseTooLongError, PassphraseTooShortError } from '$lib/crypto/kdf';
	import { returnPath } from '$lib/app/navigation';
	import { Banner, Button, Field, Notice, ProgressPanel, Step } from '$lib/components';
	import { archive } from '$lib/state/archive.svelte';
	import { index } from '$lib/state/index.svelte';
	import { toasts } from '$lib/state/toasts.svelte';
	import { session } from '$lib/state/session.svelte';

	let passphrase = $state('');
	let working = $state(false);
	let failure = $state<'wrong' | 'rate-limited' | 'unreachable' | 'no-manifest' | 'unknown' | null>(
		null
	);

	const reason = $derived(page.url.searchParams.get('reason'));
	const next = $derived(returnPath(page.url.searchParams.get('next')));
	const notSetUp = $derived(archive.health !== null && !archive.health.setup);
	const ready = $derived(passphrase !== '' && !working);

	// The index is decrypted here rather than on the archive so that a
	// reload that resumes the session gets the same treatment.
	$effect(() => {
		if (session.status === 'unlocked' && index.loading === null) {
			void goto(next, { replaceState: true });
		} else if (notSetUp) void goto(resolve('/setup'), { replaceState: true });
	});

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!ready) return;
		working = true;
		failure = null;
		try {
			await unlock(passphrase);
			passphrase = '';
			try {
				await openIndex();
			} catch (e) {
				toasts.push({ tone: 'danger', label: 'index', message: indexProblem(e) }, 0);
			}
		} catch (e) {
			// A passphrase outside the accepted length cannot be the right one, and
			// saying which limit it broke would give a guesser a hint.
			if (
				e instanceof WrongPassphraseError ||
				e instanceof PassphraseTooShortError ||
				e instanceof PassphraseTooLongError
			)
				failure = 'wrong';
			else if (e instanceof RateLimitedError) failure = 'rate-limited';
			else if (e instanceof ServerUnreachableError) failure = 'unreachable';
			else if (e instanceof MissingManifestError) failure = 'no-manifest';
			else if (e instanceof NotSetUpError) await archive.refresh();
			else failure = 'unknown';
		} finally {
			working = false;
		}
	}
</script>

<svelte:head><title>Unlock · mailarchive</title></svelte:head>

{#if reason === 'already-set-up'}
	<Banner tone="accent">
		This archive is already set up. Unlock it with your passphrase to continue.
	</Banner>
{:else if reason === 'expired'}
	<Banner tone="accent">Your session expired. Unlock again to continue where you were.</Banner>
{/if}
{#if index.loading !== null}
	<ProgressPanel
		title="Decrypting index"
		done={index.loading.done}
		total={index.loading.total}
		detail="segment {index.loading.done} of {index.loading
			.total} · {index.messages.toLocaleString()} messages"
	/>
{/if}
<Step step={1} total={1} title="Unlock" counter={false}>
	{#snippet lead()}
		Your passphrase decrypts the archive on this device. It never leaves it.
	{/snippet}
	<form onsubmit={submit}>
		<Field
			label="Passphrase"
			type="password"
			name="passphrase"
			autocomplete="current-password"
			bind:value={passphrase}
			disabled={working}
			error={failure === 'wrong'
				? 'Wrong passphrase'
				: failure === 'rate-limited'
					? 'Too many attempts. Wait a minute, then try again.'
					: null}
		/>
		<div class="actions">
			<a class="lost" href={resolve('/recover')}>Lost passphrase</a>
			<Button type="submit" busy={working} disabled={!ready}>
				{working ? 'Unlocking' : 'Unlock'}
			</Button>
		</div>
	</form>
	{#snippet notice()}
		{#if failure === 'unreachable'}
			<Notice>The server cannot be reached — try again</Notice>
		{:else if failure === 'no-manifest'}
			<Notice>
				The server has the account but lost its manifest, so the archive cannot be opened
			</Notice>
		{:else if failure === 'unknown'}
			<Notice>Something went wrong — try again</Notice>
		{/if}
	{/snippet}
</Step>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
	}

	.lost {
		font: var(--mono-sm) / 1 var(--font-mono);
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		text-decoration: none;
		color: var(--text-muted);
	}

	.lost:hover {
		color: var(--text-body);
	}
</style>
