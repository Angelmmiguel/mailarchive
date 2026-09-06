/**
 * What hitting the login rate limit looks like. Needs a server of its own
 * with the limit set low enough to reach in one sitting.
 */
import { expect, test } from '@playwright/test';
import { startServer } from '../server';

const PASSPHRASE = 'correct horse battery staple';

test('too many wrong passphrases ask the user to wait', async ({ browser }) => {
	// Setup logs in once, which counts against the same window.
	const server = await startServer({ loginAttempts: 3 });
	const page = await browser.newPage({ baseURL: server.url });

	await page.goto('/setup');
	await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
	await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Skip for now' }).click();
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);

	const field = page.getByLabel('Passphrase');
	const unlock = page.getByRole('button', { name: 'Unlock' });
	await field.fill('wrong passphrase one');
	await unlock.click();
	await expect(page.getByText('Wrong passphrase')).toBeVisible();
	await field.fill('wrong passphrase two');
	await unlock.click();
	await expect(page.getByText('Too many attempts')).toBeVisible();

	await page.context().close();
	await server.stop();
});
