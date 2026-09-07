/**
 * Lock and Unlock around the empty archive, on a server this file sets up
 * for itself. Steps build on each other and run in file order.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';

test.describe.configure({ mode: 'serial' });

let server: Server;
let page: Page;

async function createAccount(page: Page): Promise<void> {
	await page.goto('/setup');
	await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
	await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Skip for now' }).click();
	await expect(page).toHaveURL(/\/$/);
}

test.beforeAll(async ({ browser }) => {
	server = await startServer();
	page = await browser.newPage({ baseURL: server.url });
	await createAccount(page);
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

test('the empty archive shows the import prompt under the toolbar', async () => {
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
	await expect(page.getByText('0 messages')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Import messages' })).toBeEnabled();
	const toolbar = page.getByRole('navigation', { name: 'Archive' });
	await expect(toolbar.getByRole('button', { name: 'Lock' })).toBeVisible();
	await expect(page.getByRole('searchbox', { name: 'Search' })).toBeDisabled();
});

test('Lock forgets the session and opens Unlock, also after a reload', async () => {
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);
	await expect(page.getByRole('heading', { name: 'Unlock' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();

	await page.goto('/');
	await expect(page).toHaveURL(/\/unlock$/);
	await page.reload();
	await expect(page).toHaveURL(/\/unlock$/);
	await expect(page.getByRole('link', { name: 'Lost passphrase' })).toHaveAttribute(
		'href',
		/\/recover$/
	);
});

test('a wrong passphrase is rejected in place', async () => {
	const field = page.getByLabel('Passphrase');
	await field.fill('correct horse battery stapler');
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('Wrong passphrase')).toBeVisible();
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(page).toHaveURL(/\/unlock$/);

	// Shorter than any passphrase the archive accepts: rejected without a
	// round trip, and without saying so.
	await field.fill('short');
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('Wrong passphrase')).toBeVisible();
});

test('the right passphrase opens the archive and survives a reload', async () => {
	await page.getByLabel('Passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('Unlocking')).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();

	await page.reload();
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
	await expect(page.getByLabel('Passphrase')).toBeHidden();
});

test('Unlock while unlocked goes straight to the archive', async () => {
	await page.goto('/unlock');
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test('Unlock returns to the location it was reached from, inside the app only', async () => {
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);

	await page.goto('/unlock?reason=expired&next=%2Fsetup%2Faddresses');
	await expect(page.getByRole('alert')).toContainText('session expired');
	await page.getByLabel('Passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(/\/setup\/addresses$/);

	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock\?next=%2Fsetup%2Faddresses$/);

	await page.goto('/unlock?next=https%3A%2F%2Fexample.com%2F');
	await page.getByLabel('Passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(/\/$/);
});
