import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// The Go server listens on MAILARCHIVE_ADDR (its own default is :8080), and
// Vite proxies to the same address, so changing the port is one variable in
// .env.local for both halves. A bare ":port" means loopback.
const addr = process.env.MAILARCHIVE_ADDR ?? ':8080';
const apiTarget = `http://${addr.startsWith(':') ? `127.0.0.1${addr}` : addr}`;

// SvelteKit options live in svelte.config.js; passing any of them here would
// make SvelteKit ignore that file.
export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// The browser only ever talks to Vite, which forwards /api to the Go
		// server: one origin, so `Sec-Fetch-Site: same-origin` reaches Go
		// unchanged and the session cookie behaves exactly as in production.
		// No changeOrigin and no rewrite, for the same reason.
		proxy: { '/api': apiTarget }
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		expect: { requireAssertions: true }
	}
});
