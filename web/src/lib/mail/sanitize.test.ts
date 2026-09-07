// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { imagesFrom, sanitizeHtml } from './sanitize';

describe('sanitizeHtml', () => {
	it('keeps the markup a newsletter is made of', () => {
		const html =
			'<table><tbody><tr><td style="color:red"><p>Hello <b>there</b></p><ul><li>one</li></ul></td></tr></tbody></table>';

		expect(sanitizeHtml(html)).toBe(html);
	});

	it('drops scripts, handlers, forms and embedded documents', () => {
		const out = sanitizeHtml(
			'<p onclick="x()">hi</p><script>alert(1)</script><form action="/x"><input></form>' +
				'<iframe src="https://e.test"></iframe><object data="x"></object><svg onload="x()"></svg>' +
				'<a href="javascript:alert(1)">j</a><meta http-equiv="refresh" content="0">'
		);

		expect(out).toBe('<p>hi</p><a>j</a>');
	});

	it('makes links open in a new tab without a referrer', () => {
		expect(sanitizeHtml('<a href="https://e.test/x" target="_top">x</a>')).toBe(
			'<a href="https://e.test/x" target="_blank" rel="noopener noreferrer">x</a>'
		);
	});

	it('strips image sources but keeps the alternative text', () => {
		expect(sanitizeHtml('<img src="https://t.test/pixel.gif" alt="logo" width="1">')).toBe(
			'<img alt="logo" width="1">'
		);
		expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">')).toBe('<img>');
	});

	it('returns an empty string for nothing', () => {
		expect(sanitizeHtml('')).toBe('');
	});
});

describe('sanitizeHtml with images', () => {
	it('keeps remote and data images and resolves cid parts when asked', () => {
		const images = imagesFrom(new Map([['logo@fixture', 'blob:x/logo']]));
		const html =
			'<img src="https://t.test/a.png"><img src="data:image/png;base64,AA">' +
			'<img src="cid:logo@fixture"><img src="cid:missing"><img src="file:///etc/x">';

		expect(sanitizeHtml(html, images)).toBe(
			'<img src="https://t.test/a.png"><img src="data:image/png;base64,AA">' +
				'<img src="blob:x/logo"><img><img>'
		);
		expect(sanitizeHtml(html)).toBe('<img><img><img><img><img>');
	});
});
