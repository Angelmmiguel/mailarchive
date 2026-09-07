import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, stripTags } from './text';

describe('htmlToText', () => {
	it('drops styles, scripts and tags and keeps block breaks', () => {
		const html =
			'<html><head><title>T</title><style>p{color:red}</style></head><body>' +
			'<p>One&nbsp;line</p><div>Two <b>bold</b></div><script>alert(1)</script>Three<br>Four</body></html>';

		expect(htmlToText(html)).toBe('One line\nTwo bold\nThree\nFour');
	});

	it('strips the invisible characters preheaders are padded with', () => {
		expect(htmlToText('Hi&#8203;&zwnj;­ there')).toBe('Hi there');
	});
});

describe('stripTags', () => {
	it('removes dropped elements, comments and swallows what is left open', () => {
		expect(stripTags('a<style>x</style>b<script type="x">y</script >c<!-- z -->d')).toBe('a b c d');
		expect(stripTags('a<scripts>keep</scripts>b')).toBe('a keep b');
		expect(stripTags('a<script>never closed')).toBe('a ');
		expect(stripTags('a<b')).toBe('a');
	});

	it('stays linear on hostile input', () => {
		for (const hostile of [
			'<script'.repeat(20_000) + 'x'.repeat(100_000),
			'<'.repeat(50_000) + 'x'.repeat(100_000),
			'<!--'.repeat(20_000) + 'x'.repeat(100_000),
			'<script>'.repeat(20_000) + 'x'.repeat(100_000)
		]) {
			const started = performance.now();
			htmlToText(hostile);
			expect(performance.now() - started).toBeLessThan(500);
		}
	});
});

describe('decodeEntities', () => {
	it('decodes named, decimal and hex entities and leaves the rest', () => {
		expect(decodeEntities('&lt;a&gt; &#65;&#x42; &unknown; &amp;')).toBe('<a> AB &unknown; &');
	});
});
