/**
 * The list past its first page, on a server this file fills with more
 * synthetic messages than one page holds: scrolling brings the next page
 * without pulling the list back to the open thread.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type Server } from '../server';

const PASSPHRASE = 'correct horse battery staple';
const MESSAGES = 110;

test.describe.configure({ mode: 'serial' });

let server: Server;
let page: Page;

/** One plain message per number, each its own thread, newest first. */
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
const scroller = () => list().locator('.rows');

test('the list shows one page, and the next when scrolled to the end, without pulling it back to the open thread', async () => {
	await expect(page.getByText(`${MESSAGES} threads`)).toBeVisible();
	await expect(rows()).toHaveCount(100);

	await rows().first().click();
	await expect(page.getByRole('article', { name: `Message number ${MESSAGES - 1}` })).toBeVisible();
	await expect(rows().first()).toHaveAttribute('aria-current', 'page');

	await scroller().evaluate((el) => el.scrollTo(0, el.scrollHeight));
	await expect(rows()).toHaveCount(MESSAGES);
	// The open thread sits at the top, far above where the reader scrolled.
	await expect(rows().first()).not.toBeInViewport();
	const scrollTop = await scroller().evaluate((el) => el.scrollTop);
	expect(scrollTop).toBeGreaterThan(1000);
});
