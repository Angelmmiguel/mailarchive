/**
 * The list with more threads than fit on screen, on a server this file
 * fills with synthetic messages: only the rows near the viewport are in
 * the document, scrolling does not pull the list back to the open thread,
 * and a change of order or query brings that thread into view at once.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';
const MESSAGES = 110;

let server: Server;
let page: Page;

/** One plain message per number, each its own thread, newest last. */
function message(n: number): { name: string; mimeType: string; buffer: Buffer } {
	const day = String(1 + (n % 28)).padStart(2, '0');
	const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May'][Math.floor(n / 28)];
	return {
		name: `page-${n}.eml`,
		mimeType: 'message/rfc822',
		buffer: Buffer.from(
			`From: Sender ${n} <sender-${n}@example.net>\r\n` +
				'To: reader@example.org\r\n' +
				`Subject: Message number ${n}\r\n` +
				`Date: Mon, ${day} ${month} 2026 10:00:00 +0000\r\n` +
				`Message-ID: <page-${n}@example.net>\r\n\r\n` +
				`Body of message ${n}.\r\n`
		)
	};
}

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
		.setInputFiles(Array.from({ length: MESSAGES }, (_, n) => message(n)));
	await expect(page.getByTestId('toast')).toContainText(`${MESSAGES} messages added`, {
		timeout: 60_000
	});
	await page.getByRole('button', { name: 'Close import panel' }).click();
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

const list = () => page.getByRole('region', { name: 'Threads' });
const rows = () => list().getByRole('link');
const row = (n: number) => rows().filter({ hasText: new RegExp(`Message number ${n}\\b`) });
const scroller = () => list().locator('.rows');
const open = () => list().locator('[aria-current="page"]');

async function order(name: string): Promise<void> {
	await page.getByRole('button', { name: 'date' }).click();
	await page.getByRole('menuitemradio', { name }).click();
}

test('only the rows near the viewport are in the document', async () => {
	await expect(page.getByText(`${MESSAGES} threads`)).toBeVisible();
	await expect(row(MESSAGES - 1)).toBeInViewport();
	expect(await rows().count()).toBeLessThan(MESSAGES / 2);

	await scroller().evaluate((el) => el.scrollTo(0, el.scrollHeight));
	await expect(row(0)).toBeInViewport();
	await expect(row(MESSAGES - 1)).toHaveCount(0);
	expect(await rows().count()).toBeLessThan(MESSAGES / 2);
	await scroller().evaluate((el) => el.scrollTo(0, 0));
});

test('scrolling does not pull the list back to the open thread', async () => {
	await row(MESSAGES - 1).click();
	await expect(page.getByRole('article', { name: `Message number ${MESSAGES - 1}` })).toBeVisible();
	await expect(open()).toContainText(`Message number ${MESSAGES - 1}`);

	await scroller().evaluate((el) => el.scrollTo(0, el.scrollHeight));
	await expect(row(0)).toBeInViewport();
	await expect(open()).toHaveCount(0);
	expect(await scroller().evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
});

test('a new order or query brings the open thread into view at once', async () => {
	await order('Oldest first');
	// The open thread is kept in view, at the bottom now; the oldest is at the top.
	await scroller().evaluate((el) => el.scrollTo(0, 0));
	await row(0).click();
	await expect(page.getByRole('article', { name: 'Message number 0' })).toBeVisible();
	await expect(open()).toBeInViewport();

	await order('Newest first');
	await expect(row(0)).toBeInViewport();
	await expect(open()).toContainText('Message number 0');
	expect(await scroller().evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);

	const box = page.getByRole('searchbox');
	await box.fill('from:sender-0@');
	await expect(page.getByText('1 thread', { exact: true })).toBeVisible();
	await expect(open()).toBeInViewport();
	await box.fill('');
	await expect(page.getByText(`${MESSAGES} threads`)).toBeVisible();
	await expect(open()).toContainText('Message number 0');
	await expect(open()).toBeInViewport();
});
