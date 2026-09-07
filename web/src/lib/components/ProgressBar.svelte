<!-- The styleguide's 2px progress line. -->
<script lang="ts">
	interface Props {
		/** 0 to 100. */
		value: number;
		label: string;
	}

	let { value, label }: Props = $props();
	const clamped = $derived(Math.max(0, Math.min(100, value)));
</script>

<div
	class="bar"
	role="progressbar"
	aria-label={label}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-valuenow={clamped}
>
	<div class="fill" style:width="{clamped}%"></div>
</div>

<style>
	.bar {
		height: 2px;
		background: var(--n-3);
	}

	.fill {
		height: 2px;
		background: var(--n-8);
		transition: width 200ms linear;
	}
</style>
