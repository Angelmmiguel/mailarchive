/**
 * Settings, on a server this file sets up for itself and fills with the
 * synthetic fixtures: the figures, the addresses, the passphrase change
 * and the unlock with the new one, the recovery key, the export, the cache,
 * Lock and the session that expires under a change. Steps build on each other and
 * run in file order.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';
const NEW_PASSPHRASE = 'a brand new passphrase for the archive';
const fixtures = new URL('../fixtures/', import.meta.url);
const fixture = (name: string): string => new URL(name, fixtures).pathname;

test.describe.configure({ mode: 'serial' });

let server: Server;
let page: Page;

test.beforeAll(async ({ browser }) => {
	server = await startServer();
	page = await browser.newPage({ baseURL: server.url });
	await page.goto('/setup');
	await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
	await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('Email address').fill('reader@example.org');
	await page.getByRole('button', { name: 'Open archive' }).click();
	await page.getByRole('button', { name: 'Import messages' }).click();
	await page
		.getByTestId('file-input')
		.setInputFiles([fixture('newsletter.eml'), fixture('report.eml'), fixture('reply.eml')]);
	await expect(page.getByTestId('toast')).toContainText('3 messages added');
	await page.getByRole('button', { name: 'Close import panel' }).click();
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

const toolbar = () => page.getByRole('navigation', { name: 'Archive' });
const section = (name: string) => page.getByRole('region', { name });
const toast = () => page.getByTestId('toast').last();

test('Settings opens from the toolbar and shows the archive figures', async () => {
	await toolbar().getByRole('button', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(toolbar().getByRole('button', { name: 'Settings' })).toHaveAttribute(
		'aria-current',
		'page'
	);

	await page.getByRole('link', { name: 'ARCHIVE' }).click();
	await expect(page).toHaveURL(/\/$/);
	await toolbar().getByRole('button', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);

	const tiles = section('Archive').locator('dd');
	await expect(tiles).toHaveText(['3', '2', /KB$/, '1']);
	await expect(section('Own addresses').getByTestId('address')).toHaveText(['reader@example.org']);
	await expect(
		section('This device').getByText(/^[\d.]+ [KMG]?B · index is re-downloaded/)
	).toBeVisible();
});

test('the theme is a choice of this device that survives a reload', async () => {
	const html = page.locator('html');
	const picker = section('Appearance').getByRole('radiogroup', { name: 'Theme' });
	await expect(html).toHaveAttribute('data-theme', 'light');
	await expect(picker.getByRole('radio', { name: 'System' })).toHaveAttribute(
		'aria-checked',
		'true'
	);

	await picker.getByRole('radio', { name: 'Dark' }).click();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await expect(picker.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

	await picker.getByRole('radio', { name: 'Forest' }).click();
	await expect(html).toHaveAttribute('data-theme', 'forest');
	await picker.getByRole('radio', { name: 'System' }).click();
	await expect(html).toHaveAttribute('data-theme', 'light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(html).toHaveAttribute('data-theme', 'light');
});

test('the export says so where the browser cannot write into a folder', async () => {
	await page.addInitScript(() => {
		delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
	});
	await page.reload();
	const archive = section('Archive');
	await expect(archive.getByRole('button', { name: 'Export…' })).toBeDisabled();
	await expect(archive.getByText('not available in this browser')).toBeVisible();
});

test('the export writes every message back as the file it came from', async () => {
	// The folder dialog cannot be driven from a test: a picker kept in
	// memory stands in, and records what the page writes into it. The row
	// decides at load whether the picker exists, so it is installed for
	// every load and the page reloaded.
	await page.addInitScript(() => {
		const files = new Map<string, Uint8Array>();
		const folder = (path: string) => ({
			name: 'exported',
			getDirectoryHandle: (name: string) => Promise.resolve(folder(`${path}${name}/`)),
			getFileHandle: (name: string) =>
				Promise.resolve({
					createWritable: () =>
						Promise.resolve({
							write: (data: Uint8Array) => {
								files.set(`${path}${name}`, data);
								return Promise.resolve();
							},
							close: () => Promise.resolve()
						})
				})
		});
		const w = window as unknown as {
			showDirectoryPicker: () => Promise<unknown>;
			exported: () => [string, number[]][];
		};
		w.showDirectoryPicker = () => Promise.resolve(folder(''));
		w.exported = () => [...files].map(([name, bytes]) => [name, [...bytes]]);
	});
	await page.reload();
	const archive = section('Archive');
	await archive.getByRole('button', { name: 'Export…' }).click();
	await expect(toast()).toContainText('3 messages written to exported.');
	await expect(archive.getByText('3 messages written')).toBeVisible();

	const files = await page.evaluate(() =>
		(window as unknown as { exported: () => [string, number[]][] }).exported()
	);
	const names = files.map(([name]) => name).sort();
	expect(names).toEqual([
		expect.stringMatching(
			/^2026\/2026-09-02_Re_Your_charging_summary_report_is_ready_[0-9a-f]{12}\.eml$/
		),
		expect.stringMatching(
			/^2026\/2026-09-02_Your_charging_summary_report_is_ready_[0-9a-f]{12}\.eml$/
		),
		expect.stringMatching(/^2026\/2026-09-06_Tablón_de_Gómez_Project_.*_[0-9a-f]{12}\.eml$/)
	]);
	for (const [name, source] of [
		['2026-09-02_Re_', 'reply.eml'],
		['2026-09-02_Your_', 'report.eml'],
		['2026-09-06_', 'newsletter.eml']
	]) {
		const written = files.find(([file]) => file.includes(name));
		expect(written, name).toBeDefined();
		expect(Buffer.from(written![1])).toEqual(await readFile(fixture(source)));
	}
});

test('own addresses are saved to the manifest and survive a reload', async () => {
	const addresses = section('Own addresses');
	await expect(addresses.getByRole('button', { name: 'Save' })).toBeDisabled();
	await addresses.getByLabel('Email address').fill('Reader@Work.example');
	await addresses.getByRole('button', { name: 'Add' }).click();
	await expect(addresses.getByTestId('address')).toHaveText([
		'reader@example.org',
		'reader@work.example'
	]);
	await addresses.getByRole('button', { name: 'Save' }).click();
	await expect(toast()).toContainText('Own addresses saved.');
	await expect(addresses.getByRole('button', { name: 'Save' })).toBeDisabled();

	await page.reload();
	await expect(section('Own addresses').getByTestId('address')).toHaveText([
		'reader@example.org',
		'reader@work.example'
	]);
});

test('the passphrase change refuses a wrong current passphrase, then takes the new one', async () => {
	const security = section('Security');
	await security.getByRole('button', { name: 'Change' }).click();
	const form = security.getByRole('form', { name: 'Change passphrase' });
	await expect(form.getByRole('button', { name: 'Change passphrase' })).toBeDisabled();

	await form.getByLabel('Current passphrase').fill('not the passphrase at all');
	await form.getByLabel('New passphrase', { exact: true }).fill(NEW_PASSPHRASE);
	await form.getByLabel('Confirm new passphrase').fill(NEW_PASSPHRASE);
	await form.getByRole('button', { name: 'Change passphrase' }).click();
	await expect(form.getByText('Wrong passphrase')).toBeVisible();

	await form.getByLabel('Current passphrase').fill(PASSPHRASE);
	await form.getByLabel('New passphrase', { exact: true }).fill(NEW_PASSPHRASE);
	await form.getByLabel('Confirm new passphrase').fill(NEW_PASSPHRASE + 'x');
	await expect(form.getByText('The passphrases differ')).toBeVisible();
	await form.getByLabel('Confirm new passphrase').fill(NEW_PASSPHRASE);
	await form.getByRole('button', { name: 'Change passphrase' }).click();
	await expect(toast()).toContainText('Passphrase changed');
	await expect(form).toBeHidden();
});

test('Lock from Settings goes to Unlock, and the new passphrase comes back here', async () => {
	await section('This device').getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock\?next=%2Fsettings$/);

	// Locked, the address itself belongs to Unlock too.
	await page.goto('/settings');
	await expect(page).toHaveURL(/\/unlock\?next=%2Fsettings$/);

	await page.getByLabel('Passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('Wrong passphrase')).toBeVisible();
	await page.getByLabel('Passphrase').fill(NEW_PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('a new recovery key is shown once and kept until it is confirmed stored', async () => {
	const security = section('Security');
	await security.getByRole('button', { name: 'Regenerate' }).click();
	const form = security.getByRole('form', { name: 'Regenerate' });
	await expect(form.getByLabel('Current passphrase')).toBeFocused();
	await form.getByRole('button', { name: 'Cancel' }).click();
	await expect(form).toBeHidden();

	await security.getByRole('button', { name: 'Regenerate' }).click();
	await form.getByLabel('Current passphrase').fill(PASSPHRASE);
	await form.getByRole('button', { name: 'Regenerate' }).click();
	await expect(form.getByText('Wrong passphrase')).toBeVisible();
	await form.getByLabel('Current passphrase').fill(NEW_PASSPHRASE);
	await form.getByRole('button', { name: 'Regenerate' }).click();

	const words = security.getByTestId('recovery-phrase').locator('li');
	await expect(words).toHaveCount(24);
	const phrase = await words.allTextContents();
	await expect(security.getByRole('button', { name: 'Done' })).toBeDisabled();
	await expect(security.getByRole('button', { name: 'Regenerate' })).toBeDisabled();

	// Leaving the screen before Done does not lose the key: a search goes
	// to the archive, and Settings shows the same phrase on return.
	await page.getByRole('searchbox', { name: 'Search' }).fill('report');
	await expect(page).toHaveURL(/\/\?q=report$/);
	await toolbar().getByRole('button', { name: 'Settings' }).click();
	await expect(section('Security').getByTestId('recovery-phrase').locator('li')).toHaveText(phrase);
	await security.getByLabel('I have stored this key somewhere safe').check();
	await security.getByRole('button', { name: 'Done' }).click();
	await expect(security.getByTestId('recovery-phrase')).toBeHidden();
	await expect(security.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
});

test('clearing the cache makes the next unlock fetch the index again', async () => {
	const device = section('This device');
	await device.getByRole('button', { name: 'Clear' }).click();
	await expect(toast()).toContainText('Cache cleared');

	const fetched: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'GET' && request.url().includes('/api/blobs/')) {
			fetched.push(request.url());
		}
	});
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(device.getByText(/^[\d.]+ [KMG]?B · index is re-downloaded/)).toBeVisible();
	expect(fetched.length).toBeGreaterThan(0);
});

test('a session the server no longer holds sends a change to Unlock, and back', async () => {
	const addresses = section('Own addresses');
	await addresses.getByRole('button', { name: 'Remove reader@work.example' }).click();
	await page.context().clearCookies();
	await addresses.getByRole('button', { name: 'Save' }).click();
	await expect(page).toHaveURL(/\/unlock\?reason=expired&next=%2Fsettings$/);
	await expect(page.getByText('Your session expired')).toBeVisible();

	await page.getByLabel('Passphrase').fill(NEW_PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	// The change never reached the server.
	await expect(section('Own addresses').getByTestId('address')).toHaveText([
		'reader@example.org',
		'reader@work.example'
	]);
});
