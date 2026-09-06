/**
 * The onboarding screens in a real browser, via the built app the Go binary
 * embeds, against a throwaway server this file starts for itself:
 *
 *     just web-e2e
 *
 * Steps build on each other and run in file order, so a failure cascades
 * into the ones after it: read the first one.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';

test.describe.configure({ mode: 'serial' });

let server: Server;
let page: Page;
let phrase: string[] = [];

test.beforeAll(async ({ browser }) => {
	server = await startServer();
	const context = await browser.newContext({
		baseURL: server.url,
		permissions: ['clipboard-read', 'clipboard-write']
	});
	page = await context.newPage();
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

test('a server that is not set up opens on Create account', async () => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/setup$/);
	await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
	await expect(page.getByText('Step 1 of 3')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

test('the strength meter and the confirmation gate the form', async () => {
	const passphrase = page.getByLabel('Passphrase', { exact: true });
	const confirmation = page.getByLabel('Confirm passphrase');
	const submit = page.getByRole('button', { name: 'Continue' });

	await passphrase.fill('short');
	await expect(page.getByText(/too short · 5 of 12 characters/)).toBeVisible();
	await expect(page.getByText('Too short to be safe')).toBeVisible();
	await expect(submit).toBeDisabled();

	await passphrase.fill(PASSPHRASE);
	await expect(page.getByText('strong · 4 words, 28 characters')).toBeVisible();
	await expect(submit).toBeDisabled();

	await confirmation.fill('correct horse battery stapler');
	await expect(page.getByText('The passphrases differ')).toBeVisible();
	await expect(submit).toBeDisabled();

	await confirmation.fill(PASSPHRASE);
	await expect(page.getByText('The passphrases differ')).toBeHidden();
	await expect(submit).toBeEnabled();
});

test('Continue derives the keys in a worker and shows the recovery key', async () => {
	const worker = page.waitForEvent('worker');
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByText('Deriving keys…')).toBeVisible();
	expect((await worker).url()).toContain('kdf.worker');

	await expect(page).toHaveURL(/\/setup\/recovery$/);
	await expect(page.getByRole('heading', { name: 'Recovery key' })).toBeVisible();
	phrase = await page.getByTestId('recovery-phrase').locator('li').allInnerTexts();
	phrase = phrase.map((item) => item.replace(/^\d+\s*/, ''));
	expect(phrase).toHaveLength(24);
	expect(new Set(phrase).size).toBeGreaterThan(12);
	await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

test('the phrase can be copied and downloaded', async () => {
	await page.getByRole('button', { name: 'Copy' }).click();
	await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(phrase.join(' '));

	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download .txt' }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe('mailarchive-recovery-key.txt');
	const text = await readFile(await file.path(), 'utf8');
	for (const [i, word] of phrase.entries()) {
		expect(text).toContain(`${String(i + 1).padStart(2)}. ${word}`);
	}
});

test('confirming the key stored moves to Own addresses', async () => {
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page).toHaveURL(/\/setup\/addresses$/);
	await expect(page.getByRole('heading', { name: 'Your addresses' })).toBeVisible();
	await expect(page.getByText('Step 3 of 3')).toBeVisible();
});

test('the recovery key is not shown a second time', async () => {
	await page.goto('/setup/recovery');
	await expect(page.getByText('cannot be shown again')).toBeVisible();
	await expect(page.getByTestId('recovery-phrase')).toBeHidden();
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/\/setup\/addresses$/);
});

test('Skip for now opens the empty archive', async () => {
	await page.getByRole('button', { name: 'Skip for now' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test('addresses are validated, deduplicated and removable', async () => {
	await page.goto('/setup/addresses');
	const entry = page.getByLabel('Email address');

	await entry.fill('not an address');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByText('Not an email address')).toBeVisible();

	await entry.fill('Maren@Okafor.io');
	await entry.press('Enter');
	await expect(page.getByText('Not an email address')).toBeHidden();
	await entry.fill('maren@okafor.io ');
	await entry.press('Enter');
	await entry.fill('m.okafor@acme.co');
	await entry.press('Enter');
	await expect(page.getByTestId('address')).toHaveText(['maren@okafor.io', 'm.okafor@acme.co']);

	await page.getByRole('button', { name: 'Remove m.okafor@acme.co' }).click();
	await expect(page.getByTestId('address')).toHaveText(['maren@okafor.io']);
});

test('Open archive keeps a typed address and stores the list in the manifest', async () => {
	await page.getByLabel('Email address').fill('me@example.org');
	await page.getByRole('button', { name: 'Open archive' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();

	// A reload resumes the session without the passphrase, and the list is
	// read back from the manifest the server holds.
	await page.reload();
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
	await page.goto('/setup/addresses');
	await expect(page.getByTestId('address')).toHaveText(['maren@okafor.io', 'me@example.org']);
});

test('Create account on a server that is set up goes to Unlock and says why', async () => {
	await page.goto('/setup');
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock$/);

	await page.goto('/setup');
	await expect(page).toHaveURL(/\/unlock\?reason=already-set-up$/);
	await expect(page.getByRole('alert')).toContainText('already set up');
	await page.reload();
	await expect(page.getByRole('alert')).toContainText('already set up');
});
