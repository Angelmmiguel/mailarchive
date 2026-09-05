<script lang="ts">
	import '$lib/styles/app.css';

	let { children } = $props();
</script>

<main>{@render children()}</main>

<style>
	main {
		margin: 0 auto;
		max-width: 40rem;
		padding: 2rem 1rem;
	}
</style>
