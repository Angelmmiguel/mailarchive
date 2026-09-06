<!--
  A passphrase input with the strength meter: four bars and a verdict line
  that follow the value as it is typed. The verdict comes from the account
  layer; this component only draws it.
-->
<script lang="ts">
	import { passphraseStrength, STRENGTH_BARS } from '$lib/account/strength';
	import { MIN_PASSPHRASE } from '$lib/crypto/kdf';
	import Field from './Field.svelte';

	interface Props {
		label?: string;
		value?: string;
		placeholder?: string;
		error?: string | null;
		disabled?: boolean;
		autocomplete?: 'new-password' | 'current-password';
		name?: string;
	}

	let {
		label = 'Passphrase',
		value = $bindable(''),
		placeholder,
		error = null,
		disabled = false,
		autocomplete = 'new-password',
		name
	}: Props = $props();

	const bars = Array.from({ length: STRENGTH_BARS }, (_, i) => i);
	const strength = $derived(passphraseStrength(value));
	const verdict = $derived(
		value === ''
			? `At least ${MIN_PASSPHRASE} characters; a few words are easiest to remember`
			: strength.score === 0
				? `too short · ${strength.characters} of ${MIN_PASSPHRASE} characters`
				: `${strength.level} · ${strength.words} ${strength.words === 1 ? 'word' : 'words'}, ${strength.characters} characters`
	);
	const tone = $derived(strength.score >= 3 ? 'ok' : strength.score >= 1 ? 'accent' : 'danger');
</script>

<Field {label} type="password" {placeholder} {error} {disabled} {autocomplete} {name} bind:value>
	{#snippet below()}
		<span class="meter" aria-hidden="true">
			{#each bars as i (i)}
				<i class={i < strength.score ? tone : ''}></i>
			{/each}
		</span>
		<span class="verdict {value === '' ? '' : tone}" data-strength={strength.level}>
			{verdict}
		</span>
	{/snippet}
</Field>

<style>
	.meter {
		display: flex;
		gap: 3px;
		margin-top: 2px;
	}

	.meter i {
		flex: 1;
		height: 2px;
		background: var(--border);
		transition: background-color 120ms linear;
	}

	.meter .ok {
		background: var(--ok);
	}

	.meter .accent {
		background: var(--accent);
	}

	.meter .danger {
		background: var(--danger);
	}

	.verdict {
		font: var(--mono-xs) / var(--mono-leading) var(--font-mono);
		color: var(--text-faint);
	}

	.verdict.ok {
		color: var(--ok-ink);
	}

	.verdict.accent {
		color: var(--accent-ink);
	}

	.verdict.danger {
		color: var(--danger-ink);
	}
</style>
