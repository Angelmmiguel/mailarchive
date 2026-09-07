<!--
  Recover access, one screen that unfolds in three steps. The recovery key
  logs in and opens the DEK, which then waits in memory while the new
  passphrase is typed; leaving the screen before it is set zeroes the keys
  and revokes that login. The passphrase rekeys the account, which also
  retires the key just typed, so the fresh one is shown last and lives in
  the onboarding state until the user says it is stored.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { logoutOnUnload } from '$lib/api/client';
	import { ApiError } from '$lib/api/types';
	import {
		MissingManifestError,
		NotSetUpError,
		RateLimitedError,
		ServerUnreachableError,
		SessionExpiredError,
		WrongRecoveryKeyError
	} from '$lib/account/errors';
	import { openRecovery, type Recovery } from '$lib/account/recover';
	import { passphraseStrength } from '$lib/account/strength';
	import { openArchive } from '$lib/app/boot';
	import {
		Button,
		Checkbox,
		Field,
		FlowStep,
		Notice,
		PassphraseField,
		RecoveryKeyInput,
		RecoveryKeyPanel,
		Step
	} from '$lib/components';
	import { MAX_PASSPHRASE } from '$lib/crypto/kdf';
	import { InvalidRecoveryPhraseError, RECOVERY_WORDS } from '$lib/crypto/recovery';
	import { archive } from '$lib/state/archive.svelte';
	import { onboarding } from '$lib/state/onboarding.svelte';
	import { session } from '$lib/state/session.svelte';

	let stage = $state<'key' | 'passphrase' | 'done'>('key');
	// The opened archive between the two steps. Not reactive: it holds keys.
	let recovery: Recovery | null = null;

	let typed = $state('');
	// The first and last word of the accepted key: enough to recognise it,
	// while the key itself, still a credential until the rekey, stays off
	// the screen.
	let accepted = $state('');
	let keyError = $state<string | null>(null);

	let passphrase = $state('');
	let confirmation = $state('');
	let stored = $state(false);

	let working = $state(false);
	let failure = $state<
		'unreachable' | 'no-manifest' | 'rate-limited' | 'conflict' | 'unknown' | null
	>(null);

	const newPhrase = $derived(onboarding.recoveryPhrase);
	const notSetUp = $derived(archive.health !== null && !archive.health.setup);
	const strength = $derived(passphraseStrength(passphrase));
	const tooWeak = $derived(passphrase !== '' && strength.score === 0);
	const tooLong = $derived(strength.characters > MAX_PASSPHRASE);
	const mismatch = $derived(confirmation !== '' && confirmation !== passphrase);
	const keyReady = $derived(typed.trim() !== '' && !working);
	const passphraseReady = $derived(
		passphrase !== '' && !tooWeak && !tooLong && confirmation === passphrase && !working
	);

	// A server with no account belongs to Create account; a session that is
	// already open, to the archive. While the rekey runs the session opens
	// before the last step shows, which is not a reason to leave.
	$effect(() => {
		if (working) return;
		if (notSetUp) void goto(resolve('/setup'), { replaceState: true });
		else if (session.status === 'unlocked' && stage !== 'done') {
			void goto(resolve('/'), { replaceState: true });
		}
	});

	// A reload would lose the opened archive or the new phrase, so the
	// browser asks first; a page that goes anyway takes the login with it,
	// since the abandon below only runs on a navigation inside the app.
	$effect(() => {
		if (stage === 'key') return;
		const guard = (event: BeforeUnloadEvent): void => event.preventDefault();
		const revoke = (): void => {
			if (stage === 'passphrase') logoutOnUnload();
		};
		window.addEventListener('beforeunload', guard);
		window.addEventListener('pagehide', revoke);
		return () => {
			window.removeEventListener('beforeunload', guard);
			window.removeEventListener('pagehide', revoke);
		};
	});

	onDestroy(() => {
		void recovery?.abandon();
	});

	async function checkKey(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!keyReady) return;
		working = true;
		keyError = null;
		failure = null;
		try {
			recovery = await openRecovery(typed);
			const words = typed.trim().toLowerCase().split(/\s+/);
			accepted = `${words[0]} … ${words[words.length - 1]} · ${RECOVERY_WORDS} words`;
			typed = '';
			stage = 'passphrase';
		} catch (e) {
			if (e instanceof InvalidRecoveryPhraseError) {
				keyError =
					e.code === 'words'
						? 'Enter the 24 words of your recovery key'
						: 'A word is wrong — check the phrase against your copy';
			} else if (e instanceof WrongRecoveryKeyError) {
				keyError = 'This key does not belong to this archive';
			} else if (e instanceof RateLimitedError) {
				keyError = 'Too many attempts. Wait a minute, then try again.';
			} else if (e instanceof SessionExpiredError) {
				keyError = 'That took too long — enter the key again';
			} else if (e instanceof ServerUnreachableError) failure = 'unreachable';
			else if (e instanceof MissingManifestError) failure = 'no-manifest';
			else if (e instanceof NotSetUpError) await archive.refresh();
			else failure = 'unknown';
		} finally {
			working = false;
		}
	}

	/** Back to the key, with the opened archive forgotten. */
	function startOver(reason: string | null = null): void {
		const opened = recovery;
		recovery = null;
		void opened?.abandon();
		accepted = '';
		passphrase = '';
		confirmation = '';
		keyError = reason;
		failure = null;
		stage = 'key';
	}

	async function setPassphrase(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!passphraseReady || recovery === null) return;
		working = true;
		failure = null;
		try {
			const { recoveryPhrase } = await recovery.finish(passphrase);
			onboarding.recoveryPhrase = recoveryPhrase;
			passphrase = '';
			confirmation = '';
			stage = 'done';
			// The index loads while the key is being stored.
			void openArchive();
		} catch (e) {
			if (e instanceof WrongRecoveryKeyError) {
				startOver('This key no longer opens the archive — enter the current one');
			} else if (e instanceof SessionExpiredError) {
				startOver('That took too long — enter the key again');
			} else if (e instanceof RateLimitedError) failure = 'rate-limited';
			else if (e instanceof ServerUnreachableError) failure = 'unreachable';
			else if (e instanceof ApiError && e.code === 'conflict') failure = 'conflict';
			else failure = 'unknown';
		} finally {
			working = false;
		}
	}

	async function open(): Promise<void> {
		onboarding.takeRecoveryPhrase();
		await goto(resolve('/'));
	}
</script>

<svelte:head><title>Recover access · mailarchive</title></svelte:head>

<Step step={1} title="Recover access" counter={false} width="wide">
	<FlowStep number={1} label="Recovery key" state={stage === 'key' ? 'current' : 'done'}>
		{#if stage === 'key'}
			<form onsubmit={checkKey}>
				<RecoveryKeyInput bind:value={typed} error={keyError} disabled={working} />
				<div class="actions">
					<a class="aside link" href={resolve('/unlock')}>Back to Unlock</a>
					<Button type="submit" busy={working} disabled={!keyReady}>
						{working ? 'Checking' : 'Check key'}
					</Button>
				</div>
			</form>
		{:else if stage === 'passphrase'}
			<p class="accepted">{accepted}</p>
		{/if}
	</FlowStep>

	<FlowStep
		number={2}
		label="New passphrase"
		state={stage === 'key' ? 'pending' : stage === 'passphrase' ? 'current' : 'done'}
	>
		{#if stage === 'passphrase'}
			<form onsubmit={setPassphrase}>
				<PassphraseField
					bind:value={passphrase}
					name="passphrase"
					disabled={working}
					error={tooWeak
						? 'Too short to be safe'
						: tooLong
							? `At most ${MAX_PASSPHRASE} characters`
							: null}
				/>
				<Field
					label="Confirm passphrase"
					type="password"
					name="confirmation"
					placeholder="Type it again"
					autocomplete="new-password"
					bind:value={confirmation}
					disabled={working}
					error={mismatch ? 'The passphrases differ' : null}
				/>
				<div class="actions">
					<span class="aside">
						{working ? 'Deriving keys…' : 'A new recovery key is generated next'}
					</span>
					<span class="buttons">
						<Button variant="ghost" onclick={() => startOver()} disabled={working}>
							Start over
						</Button>
						<Button type="submit" busy={working} disabled={!passphraseReady}>Set passphrase</Button>
					</span>
				</div>
			</form>
		{/if}
	</FlowStep>

	<FlowStep number={3} label="New recovery key" state={stage === 'done' ? 'current' : 'pending'}>
		{#if stage === 'done' && newPhrase !== null}
			<p class="lead">
				The key you typed no longer works. This one is shown once; if you lose both your passphrase
				and this key, the archive cannot be opened by anyone.
			</p>
			<RecoveryKeyPanel phrase={newPhrase} />
			<Checkbox bind:checked={stored} name="stored">
				I have stored this key somewhere safe, outside this device.
			</Checkbox>
			<div class="actions end">
				<Button onclick={open} disabled={!stored}>Open archive</Button>
			</div>
		{/if}
	</FlowStep>

	{#snippet notice()}
		{#if failure === 'unreachable'}
			<Notice>The server cannot be reached — try again</Notice>
		{:else if failure === 'no-manifest'}
			<Notice>
				The server has the account but lost its manifest, so the archive cannot be opened
			</Notice>
		{:else if failure === 'rate-limited'}
			<Notice>Too many attempts. Wait a minute, then try again.</Notice>
		{:else if failure === 'conflict'}
			<Notice>The archive was changed on another device and has been reloaded — try again</Notice>
		{:else if failure === 'unknown'}
			<Notice>Something went wrong — try again</Notice>
		{/if}
	{/snippet}
</Step>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
	}

	.end {
		justify-content: flex-end;
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
	}

	.aside {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}

	.link {
		letter-spacing: var(--mono-tracking-tight);
		text-transform: uppercase;
		text-decoration: none;
		color: var(--text-muted);
	}

	.link:hover {
		color: var(--text-body);
	}

	.accepted {
		margin: 0;
		font: var(--mono-md) / 1.6 var(--font-mono);
		letter-spacing: 0.04em;
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}

	.lead {
		margin: 0;
		font: var(--body-md) / var(--body-leading) var(--font-body);
		color: var(--text-muted);
	}
</style>
