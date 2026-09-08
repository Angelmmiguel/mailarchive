// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { imagesFrom, sanitizeHtml, stripCssResources } from './sanitize';

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

describe('sanitizeHtml and CSS', () => {
	it('drops the resources a style attribute would load', () => {
		expect(
			sanitizeHtml(
				'<p style="background:url(https://t.test/p.gif) red;color:blue">x</p>' +
					'<p style="background-image:URL( \'https://t.test/a\' )">y</p>' +
					'<p style="background-image:image-set(&quot;https://t.test/b&quot; 1x)">z</p>'
			)
		).toBe(
			'<p style="background:none red;color:blue">x</p>' +
				'<p style="background-image:none">y</p>' +
				'<p style="background-image:none">z</p>'
		);
	});

	it('drops the resources a style element would load', () => {
		expect(
			sanitizeHtml(
				'<p>t</p><style>p{background-image:url("https://t.test/x")}li{list-style:url(https://t.test/y) inside}</style>'
			)
		).toBe('<p>t</p><style>p{background-image:none}li{list-style:none inside}</style>');
	});

	it('resolves CSS urls like image sources when images are asked for', () => {
		const images = imagesFrom(new Map([['logo@fixture', 'blob:x/logo']]));
		const html =
			'<p style="background:url(https://t.test/a.png)">a</p>' +
			'<p style="background:url(cid:logo@fixture)">b</p>' +
			'<p style="background:url(file:///etc/x)">c</p>';

		expect(sanitizeHtml(html, images)).toBe(
			'<p style="background:url(&quot;https://t.test/a.png&quot;)">a</p>' +
				'<p style="background:url(&quot;blob:x/logo&quot;)">b</p>' +
				'<p style="background:none">c</p>'
		);
	});
});

describe('stripCssResources', () => {
	it('catches the function under CSS escapes, case and spacing', () => {
		expect(stripCssResources('background:\\75rl(https://t.test/x)', null)).toBe('background:none');
		expect(stripCssResources('background:\\000075RL(x)', null)).toBe('background:none');
		expect(stripCssResources('background: Url (x)', null)).toBe('background: Url (x)');
		expect(stripCssResources('background:-webkit-image-set(url(x) 1x)', null)).toBe(
			'background:none'
		);
		expect(stripCssResources('@font-face{src:src("https://t.test/f")}', null)).toBe(
			'@font-face{src:none}'
		);
	});

	it('leaves other functions, strings and comments alone', () => {
		const css = 'color:rgb(1,2,3);width:calc(1px + 2px);content:"url(x)";/* url(y) */font:var(--f)';
		expect(stripCssResources(css, null)).toBe(css);
	});

	it('survives parentheses in strings and an unterminated call', () => {
		expect(stripCssResources('background:url(")") red', null)).toBe('background:none red');
		expect(stripCssResources('background:url(https://t.test/x', null)).toBe('background:none');
		expect(stripCssResources('a:url(x);b:url(y)', null)).toBe('a:none;b:none');
	});

	it('hands the url to the resolver unescaped and quotes what comes back', () => {
		const seen: string[] = [];
		const images = (src: string): string => {
			seen.push(src);
			return 'blob:x/"y';
		};
		expect(stripCssResources('a:url("https://t.test/\\61 b");b:url(\\"x)', images)).toBe(
			'a:url("blob:x/\\"y");b:url("blob:x/\\"y")'
		);
		expect(seen).toEqual(['https://t.test/ab', '"x']);
	});
});
