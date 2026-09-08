/**
 * The list and the reader, on a server this file sets up for itself and
 * fills with the synthetic fixtures: rows, opening a thread, bodies in
 * text and HTML, attachments and the original, moving between threads,
 * the chips in the URL, addresses after a reload, the narrow layout and
 * segments another device adds. Steps build on each other and run in
 * file order.
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

const list = () => page.getByRole('region', { name: 'Threads' });
const rows = () => list().getByRole('link');
const reader = () => page.getByRole('article', { name: /report is ready|Tablón/ });

test('the list shows threads newest first with who, what, when and how many', async () => {
	await expect(page.getByText('2 threads')).toBeVisible();
	await expect(rows()).toHaveCount(2);

	const newsletter = rows().nth(0);
	await expect(newsletter).toContainText('Ineffable Roasters');
	await expect(newsletter).toContainText('Tablón de Gómez Project');
	await expect(newsletter).toContainText('Un Honey de Nariño');
	await expect(newsletter).toContainText('06 SEP');

	const report = rows().nth(1);
	await expect(report).toContainText('me, Wallbox');
	await expect(report).toContainText('Your charging summary report is ready');
	await expect(report).toContainText('sent');
	await expect(report.getByLabel('1 attachment')).toBeVisible();
	await expect(report.getByLabel('2 messages')).toContainText('2');
	await expect(report).toContainText('02 SEP');
});

test('opening a thread shows its messages with only the newest open', async () => {
	await rows().nth(1).click();
	await expect(page).toHaveURL(/\/t\/[0-9a-f]{64}$/);
	await expect(rows().nth(1)).toHaveAttribute('aria-current', 'page');

	await expect(
		reader().getByRole('heading', { name: 'Your charging summary report is ready' })
	).toBeVisible();
	await expect(reader().getByText('2 messages')).toBeVisible();
	await expect(reader().getByText('1 attachment')).toBeVisible();
	await expect(reader().getByText('2 / 2')).toBeVisible();

	await expect(reader().getByTestId('message')).toHaveCount(1);
	const message = reader().getByTestId('message');
	await expect(message).toContainText('Wallbox <no-reply@wallbox.example.test>');
	await expect(message).toContainText('reader@example.org');
	// HTML is the view a message with HTML opens in.
	await expect(message.getByTestId('html-body').locator('p').nth(2)).toHaveText(
		'Total energy: 184 kWh over 12 sessions.'
	);
	// The inline logo lost its source: nothing is fetched to render mail.
	await expect(message.getByTestId('html-body').locator('img[src]')).toHaveCount(0);

	await message.getByRole('button', { name: 'Text' }).click();
	await expect(message.getByTestId('html-body')).toBeHidden();
	await expect(message.getByTestId('text-body')).toContainText(
		'Your charging summary report for August is attached.'
	);
	await message.getByRole('button', { name: 'HTML' }).click();

	// Until asked: then the embedded logo comes from the raw blob.
	await message.getByRole('button', { name: 'Images' }).click();
	await expect(message.getByTestId('html-body').locator('img[src^="blob:"]')).toHaveCount(1);
	await expect(message.getByRole('button', { name: 'Images' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	await reader()
		.getByRole('button', { name: /Thanks, the numbers look right/ })
		.click();
	await expect(reader().getByTestId('message')).toHaveCount(2);
	await expect(reader().getByTestId('message').nth(0).getByTestId('text-body')).toContainText(
		'Señal recibida.'
	);
});

test('an attachment, the original and the source come from the raw blob', async () => {
	const message = reader().getByTestId('message').nth(1);

	// Headless Chromium has no PDF viewer, so the tab may turn into a download.
	const opened = Promise.any([
		page
			.context()
			.waitForEvent('page')
			.then((popup) => popup.url()),
		page.waitForEvent('download').then((d) => d.suggestedFilename())
	]);
	await message.getByRole('button', { name: /charging-summary-august\.pdf/ }).click();
	expect(await opened).toMatch(/^blob:|\.pdf$/);

	const download = page.waitForEvent('download');
	await message.getByRole('button', { name: '↓ .eml' }).click();
	expect((await download).suggestedFilename()).toBe('Your_charging_summary_report_is_ready.eml');

	await message.getByRole('button', { name: 'Source' }).click();
	await expect(message.getByTestId('source')).toContainText('Message-ID: <HWnqaDLqScir3bd-3iy5ag@');
	await message.getByRole('button', { name: 'HTML' }).click();
	await expect(message.getByTestId('source')).toBeHidden();
});

test('prev, next and the arrow keys move through the listing', async () => {
	await expect(reader().getByText('↓ next')).toHaveAttribute('aria-disabled', 'true');
	await reader().getByRole('link', { name: '↑ prev' }).click();
	await expect(reader().getByRole('heading', { name: 'Tablón de Gómez Project 🇨🇴' })).toBeVisible();
	await expect(
		reader().getByTestId('message').getByRole('button', { name: 'Images' })
	).toHaveAttribute('aria-pressed', 'false');
	await expect(reader().getByText('1 / 2')).toBeVisible();
	await expect(reader().getByText('↑ prev')).toHaveAttribute('aria-disabled', 'true');

	await page.keyboard.press('ArrowDown');
	await expect(reader().getByText('2 / 2')).toBeVisible();
	await page.keyboard.press('k');
	await expect(reader().getByText('1 / 2')).toBeVisible();
});

test('filters narrow the list, travel in the URL and survive a reload', async () => {
	await page.getByRole('button', { name: 'attachments' }).click();
	await expect(page).toHaveURL(/\?q=has%3Aattachment$/);
	await expect(page.getByText('1 thread')).toBeVisible();
	await expect(rows()).toHaveCount(1);
	// The open thread is not in the narrowed list, and says so.
	await expect(reader().getByText('– / 1')).toBeVisible();

	await page.getByRole('button', { name: 'sent' }).click();
	await expect(page).toHaveURL(/\?q=has%3Aattachment%20is%3Asent$/);
	await expect(rows()).toHaveCount(1);

	await page.reload();
	await expect(page.getByRole('button', { name: 'sent' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'attachments' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(rows()).toHaveCount(1);

	await page.getByRole('button', { name: 'sent' }).click();
	await page.getByRole('button', { name: 'attachments' }).click();
	await expect(page).toHaveURL(/\/t\/[0-9a-f]{64}$/);
	await expect(page.getByText('2 threads')).toBeVisible();
});

test('a thread address survives a reload and an unknown one is reported', async () => {
	await page.reload();
	await expect(reader().getByRole('heading', { name: 'Tablón de Gómez Project 🇨🇴' })).toBeVisible();

	await page.goto(`/t/${'0'.repeat(64)}`);
	await expect(page.getByRole('heading', { name: 'Thread not found' })).toBeVisible();
	await page.goto('/t/not-a-key');
	await expect(page.getByRole('heading', { name: 'Thread not found' })).toBeVisible();
	await page.getByRole('link', { name: 'Back to the archive' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(rows()).toHaveCount(2);
});

test('a narrow screen shows the list or the thread, not both', async () => {
	await page.setViewportSize({ width: 600, height: 800 });
	await expect(list()).toBeVisible();
	await expect(page.getByText('Select a thread to read it.')).toBeHidden();

	await rows().nth(0).click();
	await expect(reader().getByRole('heading', { name: 'Tablón de Gómez Project 🇨🇴' })).toBeVisible();
	await expect(list()).toBeHidden();

	await reader().getByRole('link', { name: '← Archive' }).click();
	await expect(list()).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 720 });
	await expect(page.getByText('Select a thread to read it.')).toBeVisible();
});

test('segments another device adds are offered for reload', async ({ browser }) => {
	const other = await browser.newPage({ baseURL: server.url });
	await other.goto('/unlock');
	await other.getByLabel('Passphrase').fill(PASSPHRASE);
	await other.getByRole('button', { name: 'Unlock' }).click();
	await expect(other.getByText('2 threads')).toBeVisible();
	await other
		.getByRole('navigation', { name: 'Archive' })
		.getByRole('button', { name: 'Import' })
		.click();
	await other.getByTestId('file-input').setInputFiles({
		name: 'elsewhere.eml',
		mimeType: 'message/rfc822',
		buffer: Buffer.from(
			'From: Elsewhere <elsewhere@example.net>\r\nTo: reader@example.org\r\nSubject: From another device\r\nDate: Mon, 07 Sep 2026 10:00:00 +0000\r\nMessage-ID: <elsewhere-1@example.net>\r\n\r\nImported elsewhere.\r\n'
		)
	});
	await expect(other.getByTestId('toast')).toContainText('1 message added');
	await other.context().close();

	await expect(page.getByText('Another device added')).toBeHidden();
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText('Another device added 1 segment since unlock')).toBeVisible();
	await page.getByRole('button', { name: 'Reload' }).click();
	await expect(page.getByText('3 threads')).toBeVisible();
	await expect(rows().nth(0)).toContainText('From another device');
	await expect(page.getByText('Another device added')).toBeHidden();
});
