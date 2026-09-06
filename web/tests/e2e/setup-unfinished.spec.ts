/**
 * The case the account layer cannot handle on its own: setup succeeds but
 * the login right after it never reaches the server, so the account exists
 * and the recovery phrase was never shown. Needs its own fresh server.
 */
import { expect, test } from '@playwright/test';
import { startServer } from '../server';

test('a setup that succeeds without a phrase is reported and points to Unlock', async ({
	browser
}) => {
	const server = await startServer();
	const context = await browser.newContext({ baseURL: server.url });
	const page = await context.newPage();
	await page.route('**/api/login', (route) => route.abort('connectionfailed'));

	await page.goto('/setup');
	await page.getByLabel('Passphrase', { exact: true }).fill('correct horse battery staple');
	await page.getByLabel('Confirm passphrase').fill('correct horse battery staple');
	await page.getByRole('button', { name: 'Continue' }).click();

	const notice = page.getByRole('status');
	await expect(notice).toContainText('created');
	await expect(notice).toContainText('generate a recovery key from Settings');
	await expect(page).toHaveURL(/\/setup$/);

	// The account exists: the server is set up, so Create account is no
	// longer reachable and a reload lands on Unlock with the reason.
	await page.unroute('**/api/login');
	await page.reload();
	await expect(page).toHaveURL(/\/unlock\?reason=already-set-up$/);
	await expect(page.getByRole('alert')).toContainText('already set up');

	await context.close();
	await server.stop();
});
