<!--
  A message's HTML, already sanitized, rendered inside a shadow root so
  that its styles stay in and the page's stay out. No script can run
  there: the sanitizer removed them and the policy forbids inline ones.
-->
<script lang="ts">
	interface Props {
		/** Output of `sanitizeHtml`, never anything else. */
		html: string;
	}

	let { html }: Props = $props();
	let host = $state<HTMLElement | null>(null);

	const BASE =
		'<style>:host{display:block;font:17px/1.65 var(--font-body);color:var(--text-body);overflow-wrap:anywhere}' +
		'img:not([src]){display:none}table{max-width:100%}</style>';

	$effect(() => {
		if (host === null) return;
		const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
		root.innerHTML = BASE + html;
	});
</script>

<div class="body" bind:this={host} data-testid="html-body"></div>

<style>
	.body {
		max-width: 100%;
		overflow-x: auto;
	}
</style>
