<!-- The archive's figures as a row of bordered tiles. -->
<script lang="ts">
	interface Props {
		stats: { label: string; value: string }[];
	}

	let { stats }: Props = $props();
</script>

<dl class="tiles">
	{#each stats as stat (stat.label)}
		<div class="tile">
			<dt>{stat.label}</dt>
			<dd>{stat.value}</dd>
		</div>
	{/each}
</dl>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		max-width: 560px;
		margin: 0;
		border-top: var(--hairline);
		border-left: var(--hairline);
	}

	.tile {
		padding: var(--space-3);
		border-right: var(--hairline);
		border-bottom: var(--hairline);
	}

	dt {
		font: var(--mono-xs) / 1.4 var(--font-mono);
		letter-spacing: var(--mono-tracking);
		text-transform: uppercase;
		color: var(--text-faint);
	}

	dd {
		margin: 0;
		font: 500 var(--mono-xl) / 1.3 var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
</style>
