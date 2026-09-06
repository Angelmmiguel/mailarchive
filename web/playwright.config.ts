import { defineConfig, devices } from '@playwright/test';

// Browser tests against the built app the Go binary embeds, so the real CSP,
// the real worker and the real cookies are exercised. Each spec file starts
// its own throwaway server through tests/server.ts, since each assumes an
// archive that has never been set up; `just web-e2e` builds the app first.
export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	// Argon2id at the production cost runs a few times per file.
	timeout: 90_000,
	expect: { timeout: 15_000 },
	use: { trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
