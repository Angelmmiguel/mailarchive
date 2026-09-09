/**
 * The app on a phone: nothing scrolls sideways on any screen, and the
 * toolbar's actions fold into a menu that still reaches Import, Settings
 * and Lock. Runs on its own server at a phone viewport.
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
	page = await browser.newPage({
		baseURL: server.url,
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true
	});
});

test.afterAll(async () => {
	await page.context().close();
	await server.stop();
});

/** Whether anything, the document or a scroller inside it, is wider than the screen. */
async function scrollsSideways(): Promise<string[]> {
	return page.evaluate(() => {
		const wide: string[] = [];
		const root = document.documentElement;
		if (root.scrollWidth > root.clientWidth) wide.push('document');
		for (const el of document.querySelectorAll<HTMLElement>(
			'main, .shell, .archive, .threads, .pane'
		))
			if (el.scrollWidth > el.clientWidth) wide.push(el.tagName.toLowerCase() + '.' + el.className);
		return wide;
	});
}

const menu = () =>
	page.getByRole('navigation', { name: 'Archive' }).getByRole('button', { name: /^Menu/ });
const item = (name: string) => page.getByRole('menuitem', { name });

test('onboarding fits the screen', async () => {
	await page.goto('/setup');
	expect(await scrollsSideways()).toEqual([]);
	await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
	await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
	await page.getByRole('button', { name: 'Continue' }).click();
	expect(await scrollsSideways()).toEqual([]);
	await page.getByLabel('I have stored this key somewhere safe').check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel('Email address').fill('reader@example.org');
	await page.getByRole('button', { name: 'Open archive' }).click();
	await expect(page.getByRole('heading', { name: 'The archive is empty' })).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
});

test('the toolbar folds its actions into a menu that opens Import', async () => {
	const nav = page.getByRole('navigation', { name: 'Archive' });
	await expect(nav.getByRole('button', { name: 'Settings' })).toHaveCount(0);
	await expect(page.getByRole('searchbox')).toBeVisible();
	await menu().click();
	await expect(item('Import')).toBeVisible();
	await item('Import').click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await page
		.getByTestId('file-input')
		.setInputFiles([fixture('newsletter.eml'), fixture('report.eml'), fixture('reply.eml')]);
	await expect(page.getByTestId('toast')).toContainText('3 messages added');
	await page.getByRole('button', { name: 'Close import panel' }).click();
});

test('the list and the reader fit the screen', async () => {
	await expect(page.getByRole('link', { name: /Tablón/ })).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
	await page.getByRole('link', { name: /Tablón/ }).click();
	await expect(page.getByRole('heading', { name: /Tablón/ }).first()).toBeVisible();
	await expect(page.getByTestId('html-body')).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
	await page.getByRole('link', { name: 'next' }).click();
	await expect(page.getByRole('heading', { name: /charging/ }).first()).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
});

test('the menu reaches Settings, which fits, and closes on Escape', async () => {
	await menu().click();
	await item('Settings').click();
	await expect(page).toHaveURL(/\/settings$/);
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
	await menu().click();
	await expect(item('Settings')).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(menu()).toBeFocused();
});

test('the menu locks the archive', async () => {
	await menu().click();
	await item('Lock').click();
	await expect(page).toHaveURL(/\/unlock/);
	await expect(page.getByLabel('Passphrase', { exact: true })).toBeVisible();
	expect(await scrollsSideways()).toEqual([]);
});
