/**
 * Recovering access with the recovery key, on a server this file sets up
 * for itself: the key is checked before the passphrase is asked, leaving
 * step 2 forgets the opened archive, the rekey shows a fresh key, and the
 * old key and passphrase stop working. Steps build on each other and run
 * in file order.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'a brand new passphrase';
// The BIP39 test vector: 23 × abandon + art passes the checksum, so it is
// a well-formed key that belongs to no archive.
const FOREIGN_KEY = `${'abandon '.repeat(23)}art`;

test.describe.configure({ mode: 'serial' });

let server: Server;
let page: Page;
let phrase: string[] = [];
let newPhrase: string[] = [];

const words = async (): Promise<string[]> => {
	const items = page.getByTestId('recovery-phrase').locator('li');
	await expect(items).toHaveCount(24);
	return (await items.allInnerTexts()).map((item) => item.replace(/^\d+\s*/, ''));
};
const step = (n: number, label: string) => page.getByRole('region', { name: `${n} · ${label}` });
const loggedIn = (): Promise<number> =>
	page.evaluate(() => fetch('/api/manifest').then((r) => r.status));

test.beforeAll(async ({ browser }) => {
	server = await startServer();
	page = await browser.newPage({ baseURL: server.url });
	await page.goto('/setup');
	await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
	await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();
	phrase = await words();
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Skip for now' }).click();
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

test('Lost passphrase leads to Recover, which checks the key first', async () => {
	await page.getByRole('link', { name: 'Lost passphrase' }).click();
	await expect(page).toHaveURL(/\/recover$/);
	await expect(page.getByRole('heading', { name: 'Recover access' })).toBeVisible();
	await expect(step(1, 'Recovery key')).toHaveAttribute('aria-current', 'step');
	const key = page.getByLabel('Recovery key', { exact: true });
	await expect(key).toBeFocused();
	await expect(page.getByRole('button', { name: 'Check key' })).toBeDisabled();

	await key.fill('not a recovery key');
	await key.press('Enter');
	await expect(page.getByText('Enter the 24 words of your recovery key')).toBeVisible();

	await key.fill('abandon '.repeat(24));
	await page.getByRole('button', { name: 'Check key' }).click();
	await expect(page.getByText('A word is wrong')).toBeVisible();

	await key.fill(FOREIGN_KEY);
	await page.getByRole('button', { name: 'Check key' }).click();
	await expect(page.getByText('This key does not belong to this archive')).toBeVisible();
	await expect(step(1, 'Recovery key')).toHaveAttribute('aria-current', 'step');
});

test('the right key opens step 2; Start over forgets the opened archive', async () => {
	expect(await loggedIn()).toBe(401);
	await page.getByLabel('Recovery key', { exact: true }).fill(phrase.join('\n').toUpperCase());
	await page.getByRole('button', { name: 'Check key' }).click();

	await expect(step(2, 'New passphrase')).toHaveAttribute('aria-current', 'step');
	// The key is recognisable but not on screen: it still opens the archive.
	await expect(step(1, 'Recovery key')).toContainText(`${phrase[0]} … ${phrase[23]} · 24 words`);
	await expect(step(1, 'Recovery key')).not.toContainText(phrase.slice(0, 3).join(' '));
	await expect(page.getByLabel('Passphrase', { exact: true })).toBeVisible();
	expect(await loggedIn()).toBe(200);

	await page.getByRole('button', { name: 'Start over' }).click();
	await expect(step(1, 'Recovery key')).toHaveAttribute('aria-current', 'step');
	await expect(page.getByLabel('Recovery key', { exact: true })).toHaveValue('');
	await expect.poll(loggedIn).toBe(401);
});

test('a new passphrase rekeys the account and shows a fresh key', async () => {
	await page.getByLabel('Recovery key', { exact: true }).fill(phrase.join(' '));
	await page.getByRole('button', { name: 'Check key' }).click();
	const passphrase = page.getByLabel('Passphrase', { exact: true });
	const confirmation = page.getByLabel('Confirm passphrase');
	const submit = page.getByRole('button', { name: 'Set passphrase' });

	await passphrase.fill('short');
	await expect(page.getByText('Too short to be safe')).toBeVisible();
	await expect(submit).toBeDisabled();
	await passphrase.fill(NEW_PASSPHRASE);
	await confirmation.fill('a brand new passphrases');
	await expect(page.getByText('The passphrases differ')).toBeVisible();
	await expect(submit).toBeDisabled();
	await confirmation.fill(NEW_PASSPHRASE);
	await expect(submit).toBeEnabled();
	await submit.click();

	await expect(step(3, 'New recovery key')).toHaveAttribute('aria-current', 'step');
	newPhrase = await words();
	expect(newPhrase).toHaveLength(24);
	expect(newPhrase).not.toEqual(phrase);
	await expect(page.getByText('The key you typed no longer works')).toBeVisible();
	const open = page.getByRole('button', { name: 'Open archive' });
	await expect(open).toBeDisabled();
	await page.getByLabel('I have stored this key somewhere safe').check();
	await open.click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test('an open session sends Recover to the archive', async () => {
	await page.goto('/recover');
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test('only the new passphrase unlocks', async () => {
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);
	const field = page.getByLabel('Passphrase');
	await field.fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('Wrong passphrase')).toBeVisible();
	await field.fill(NEW_PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test('the old key is retired and the new one opens the archive', async () => {
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);
	await page.getByRole('link', { name: 'Lost passphrase' }).click();
	const key = page.getByLabel('Recovery key', { exact: true });
	await key.fill(phrase.join(' '));
	await page.getByRole('button', { name: 'Check key' }).click();
	await expect(page.getByText('This key does not belong to this archive')).toBeVisible();

	await key.fill(newPhrase.join(' '));
	await page.getByRole('button', { name: 'Check key' }).click();
	await expect(step(2, 'New passphrase')).toHaveAttribute('aria-current', 'step');

	// Leaving the screen forgets the opened archive too.
	await page.goBack();
	await expect(page).toHaveURL(/\/unlock$/);
	await expect.poll(loggedIn).toBe(401);
});
