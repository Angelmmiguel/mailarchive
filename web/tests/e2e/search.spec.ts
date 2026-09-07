/**
 * Searching the archive, on a server this file sets up for itself and
 * fills with the synthetic fixtures: words as you type, the term index
 * arriving after the list, operators and the chips that write them, the
 * date and order menu, nothing found and the ways out of it, the help
 * card, the query in the URL across reloads and thread pages, and the
 * cache sparing the server on the next load. Steps build on each other
 * and run in file order.
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
		.setInputFiles([
			fixture('newsletter.eml'),
			fixture('report.eml'),
			fixture('reply.eml'),
			fixture('long.eml')
		]);
	await expect(page.getByTestId('toast')).toContainText('4 messages added');
	await page.getByRole('button', { name: 'Close import panel' }).click();
	await expect(page.getByText('3 threads')).toBeVisible();
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

const box = () => page.getByRole('searchbox', { name: 'Search' });
const list = () => page.getByRole('region', { name: 'Threads' });
const rows = () => list().getByRole('link');

test('words narrow the list as they are typed and travel in the URL', async () => {
	await box().fill('charg');
	await expect(page).toHaveURL(/\?q=charg$/);
	await expect(page.getByText('1 thread')).toBeVisible();
	await expect(rows().first()).toContainText('charging summary report');

	await box().fill('charging okafor');
	await expect(page.getByText('0 threads')).toBeVisible();
	await box().fill('');
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByText('3 threads')).toBeVisible();
});

test('a word deep in a body is found through the term index', async () => {
	// The snippet ends long before this word; only the shards know it.
	await box().fill('photovoltaic');
	await expect(rows()).toHaveCount(1);
	await expect(rows().first()).toContainText('Site visit notes');
	await box().fill('-photovoltaic');
	await expect(rows()).toHaveCount(2);
	await box().fill('"punch list"');
	await expect(rows()).toHaveCount(1);
});

test('operators and the chips that write them agree', async () => {
	await box().fill('from:okafor');
	await expect(rows()).toHaveCount(1);
	await expect(rows().first()).toContainText('Maren Okafor');
	await box().fill('to:finance');
	await expect(rows()).toHaveCount(1);
	await box().fill('from:me');
	await expect(rows().first()).toContainText('charging summary');

	// A chip clicked right after typing, inside the debounce, keeps the typed text.
	await box().fill('report');
	await page.getByRole('button', { name: 'attachments' }).click();
	await expect(box()).toHaveValue('report has:attachment');
	await expect(page).toHaveURL(/\?q=report%20has%3Aattachment$/);
	await expect(rows()).toHaveCount(1);
	await page.getByRole('button', { name: 'sent' }).click();
	await expect(box()).toHaveValue('report has:attachment is:sent');
	await expect(page.getByRole('button', { name: 'sent' })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('button', { name: 'sent' }).click();
	await page.getByRole('button', { name: 'attachments' }).click();
	await expect(box()).toHaveValue('report');
	await box().fill('subject:visit after:2026-07 before:2026-08');
	await expect(rows()).toHaveCount(1);
	await box().fill('subject:visit after:2026-08');
	await expect(page.getByText('0 threads')).toBeVisible();
});

test('the date chip offers ranges and the order, spelled into the query', async () => {
	await box().fill('');
	await expect(page).toHaveURL(/\/$/);
	await page.getByRole('button', { name: 'date' }).click();
	const menu = page.getByRole('menu', { name: 'date' });
	await expect(menu.getByRole('menuitemradio')).toHaveText([
		'Any time',
		'Last 30 days',
		'Last 12 months',
		'2026',
		'Newest first',
		'Oldest first'
	]);
	await menu.getByRole('menuitemradio', { name: '2026' }).click();
	await expect(box()).toHaveValue('after:2026 before:2027');
	await expect(page.getByRole('button', { name: '2026' })).toHaveAttribute(
		'aria-expanded',
		'false'
	);
	await expect(rows()).toHaveCount(3);

	await page.getByRole('button', { name: '2026' }).click();
	await page.getByRole('menuitemradio', { name: 'Oldest first' }).click();
	await expect(page).toHaveURL(/order=oldest$/);
	await expect(rows().first()).toContainText('Site visit notes');
	await expect(rows().last()).toContainText('Tablón de Gómez');

	await box().fill('visit after:2026 before:2027');
	await expect(page).toHaveURL(/q=visit/);
	await page.getByRole('button', { name: '2026' }).click();
	await expect(page.getByRole('menuitemradio', { name: 'Best match' })).toBeVisible();
	await page.getByRole('menuitemradio', { name: 'Best match' }).click();
	await expect(page).not.toHaveURL(/order=/);
});

test('nothing found says what was asked and offers the ways out', async () => {
	await box().fill('quarterly after:2024-01 before:2024-03');
	await expect(page.getByRole('heading', { name: 'No results' })).toBeVisible();
	await expect(
		list().getByText('Nothing matches quarterly between 2024-01 and 2024-03.')
	).toBeVisible();
	await expect(page.getByRole('button', { name: '2024-01 – 2024-03' })).toBeVisible();

	await page.getByRole('button', { name: 'Clear date range' }).click();
	await expect(box()).toHaveValue('quarterly');
	await expect(list().getByText('Nothing matches quarterly.')).toBeVisible();
	await page.getByRole('button', { name: 'Clear all' }).click();
	await expect(box()).toHaveValue('');
	await expect(rows()).toHaveCount(3);
});

test('the help card explains the syntax and its examples fill the box', async () => {
	await page.getByRole('button', { name: 'Search help' }).click();
	const help = page.getByRole('dialog', { name: 'Search help' });
	await expect(help).toContainText('has:attachment');
	await expect(help).toContainText('before:2026-09-03');
	await help.getByRole('button', { name: 'from:okafor has:attachment' }).click();
	await expect(help).toBeHidden();
	await expect(box()).toHaveValue('from:okafor has:attachment');
	await expect(box()).toBeFocused();
	await expect(page.getByRole('heading', { name: 'No results' })).toBeVisible();

	await page.getByRole('button', { name: 'Search help' }).click();
	await expect(help).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(help).toBeHidden();
	await box().fill('');
});

test('the query in a link comes back in the box, on the list and beside a thread', async () => {
	await page.goto('/?q=from%3Awallbox');
	await expect(box()).toHaveValue('from:wallbox');
	await expect(rows()).toHaveCount(1);

	await rows().first().click();
	await expect(page).toHaveURL(/\/t\/[0-9a-f]{64}\?q=from%3Awallbox$/);
	const reader = page.getByRole('article', { name: /charging summary/ });
	await expect(reader.getByText('1 / 1')).toBeVisible();
	await box().fill('visit');
	await expect(page).toHaveURL(/\/t\/[0-9a-f]{64}\?q=visit$/);
	await expect(reader.getByText('– / 1')).toBeVisible();
	// Typing beside a thread replaces the entry; back is the list as it was linked.
	await page.goBack();
	await expect(page).toHaveURL(/\/\?q=from%3Awallbox$/);
	await expect(box()).toHaveValue('from:wallbox');
	await expect(rows()).toHaveCount(1);
});

test('the next load reads the index and shards from the cache, not the server', async () => {
	const fetched: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'GET' && request.url().includes('/api/blobs/')) {
			fetched.push(request.url());
		}
	});
	await page.goto('/?q=photovoltaic');
	await expect(rows()).toHaveCount(1);
	expect(fetched).toEqual([]);
});
