/**
 * Importing .eml files through the panel, on a server this file sets up
 * for itself: the counts, the summary toast, duplicates on a second run,
 * the index surviving lock, unlock and reload, and the warning when the
 * tab is closed mid-run. Steps build on each other and run in file order.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';
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
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

test('the empty archive opens the import panel with the drop zone', async () => {
	await page.getByRole('button', { name: 'Import messages' }).click();
	const panel = page.getByTestId('import-panel');
	await expect(panel).toBeVisible();
	await expect(panel.getByText('Drop .eml files or a folder here')).toBeVisible();

	await panel.getByRole('button', { name: 'Close import panel' }).click();
	await expect(panel).toBeHidden();
	await page
		.getByRole('navigation', { name: 'Archive' })
		.getByRole('button', { name: 'Import' })
		.click();
	await expect(panel).toBeVisible();
});

test('chosen files are parsed, uploaded and summarised', async () => {
	await page
		.getByTestId('file-input')
		.setInputFiles([
			fixture('newsletter.eml'),
			fixture('report.eml'),
			fixture('reply.eml'),
			fixture('broken.eml')
		]);

	const panel = page.getByTestId('import-panel');
	await expect(panel.getByText('Imported 4 files')).toBeVisible();
	await expect(panel.getByText('4 of 4 files')).toBeVisible();
	await expect(panel.locator('dd')).toHaveText(['3', '3', '0', '1']);
	await expect(panel.getByText('broken.eml')).toBeVisible();

	const toast = page.getByTestId('toast');
	await expect(toast).toContainText('Import finished. 3 messages added, 0 duplicates, 1 failed.');
	await toast.getByRole('link', { name: 'View' }).click();
	await expect(toast).toBeHidden();
	await expect(page.getByRole('region', { name: 'Threads' })).toBeVisible();
	await expect(page.getByText('2 threads')).toBeVisible();
});

test('importing the same messages again finds only duplicates', async () => {
	const panel = page.getByTestId('import-panel');
	await panel.getByRole('button', { name: 'Import more' }).click();
	await page
		.getByTestId('file-input')
		.setInputFiles([fixture('report.eml'), fixture('report-reexport.eml')]);

	await expect(panel.locator('dd')).toHaveText(['1', '0', '2', '0']);
	await expect(page.getByTestId('toast').last()).toContainText(
		'Import finished. 0 messages added, 2 duplicates, 0 failed.'
	);
	await expect(page.getByText('2 threads')).toBeVisible();
});

test('a dropped file anywhere on the page starts an import', async () => {
	const transfer = await page.evaluateHandle(() => {
		const dt = new DataTransfer();
		dt.items.add(
			new File(
				[
					'From: Drop <drop@example.net>\r\nTo: reader@example.org\r\nSubject: Dropped\r\nDate: Thu, 03 Sep 2026 10:00:00 +0000\r\nMessage-ID: <drop-1@example.net>\r\n\r\nDropped body.\r\n'
				],
				'dropped.eml',
				{ type: 'message/rfc822' }
			)
		);
		return dt;
	});
	await page.dispatchEvent('main', 'drop', { dataTransfer: transfer });

	await expect(page.getByTestId('toast').last()).toContainText('1 message added');
	await expect(page.getByText('3 threads')).toBeVisible();
});

test('the index comes back after lock, unlock and reload', async () => {
	await page.getByRole('button', { name: 'Lock' }).click();
	await expect(page).toHaveURL(/\/unlock/);
	await page.getByLabel('Passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.getByText('3 threads')).toBeVisible();

	await page.reload();
	await expect(page.getByText('3 threads')).toBeVisible();

	// Dedup works from the freshly loaded index too.
	await page
		.getByRole('navigation', { name: 'Archive' })
		.getByRole('button', { name: 'Import' })
		.click();
	await expect(page.getByTestId('import-panel')).toBeVisible();
	await page.getByTestId('file-input').setInputFiles([fixture('reply.eml')]);
	await expect(page.getByTestId('toast').last()).toContainText('0 messages added, 1 duplicate');
});

test('closing the tab during an import is guarded until the run ends', async () => {
	// Headless Chromium never shows the beforeunload prompt, so the guard
	// is observed directly: the event is cancelled while a run is going.
	const guarded = (): Promise<boolean> =>
		page.evaluate(() => {
			const event = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		});
	expect(await guarded()).toBe(false);

	// Hold the uploads so the run is still going when the guard is checked.
	await page.route('**/api/blobs/*', async (route) => {
		await new Promise((r) => setTimeout(r, 1500));
		await route.continue();
	});
	await page.getByTestId('import-panel').getByRole('button', { name: 'Import more' }).click();
	// A message the archive has not seen, so the run reaches the upload.
	await page.getByTestId('file-input').setInputFiles({
		name: 'fresh.eml',
		mimeType: 'message/rfc822',
		buffer: Buffer.from(
			'From: Fresh <fresh@example.net>\r\nTo: reader@example.org\r\nSubject: Fresh\r\nDate: Fri, 04 Sep 2026 10:00:00 +0000\r\nMessage-ID: <fresh-1@example.net>\r\n\r\nStill uploading.\r\n'
		)
	});
	await expect(page.getByRole('button', { name: /Import, \d+% done/ })).toBeVisible();
	expect(await guarded()).toBe(true);

	await expect(page.getByTestId('toast').last()).toContainText('1 message added', {
		timeout: 30_000
	});
	expect(await guarded()).toBe(false);
	await page.unroute('**/api/blobs/*');
});
