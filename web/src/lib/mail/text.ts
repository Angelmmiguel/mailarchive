/**
 * HTML to plain text without a DOM, so it runs in the import worker. Good
 * enough for snippets and search terms: block boundaries become line
 * breaks, hidden preheaders and styles are dropped, entities are decoded.
 * One forward pass: a regex with a lazy `.*?` would rescan to the end for
 * every unclosed opener, which a hostile body turns into hours.
 */
const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	shy: '',
	zwnj: '',
	zwj: ''
};

/** Elements dropped with their content. */
const DROPPED = new Set(['script', 'style', 'head', 'title']);
/** Closing tags that end a block, and `br`, which become a line break. */
const BREAKS = new Set([
	'br',
	'p',
	'div',
	'tr',
	'li',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'table',
	'section',
	'article',
	'pre'
]);

export function htmlToText(html: string): string {
	return (
		decodeEntities(stripTags(html))
			// Soft hyphens, zero-width characters and the like, which preheaders are padded with.
			.replace(/\u00ad|[\u200b-\u200d]|\u034f|\ufeff/g, '')
			.replace(/[ \t\u00a0]+/g, ' ')
			.replace(/\s*\n\s*/g, '\n')
			.trim()
	);
}

/**
 * Replaces tags by a space or a line break and removes dropped elements
 * and comments whole. Anything left open runs to the end, as in a browser.
 */
export function stripTags(html: string): string {
	const lower = html.toLowerCase();
	let out = '';
	let at = 0;
	for (;;) {
		const open = html.indexOf('<', at);
		if (open === -1) return out + html.slice(at);
		out += html.slice(at, open);
		if (lower.startsWith('<!--', open)) {
			const end = lower.indexOf('-->', open + 4);
			if (end === -1) return out;
			at = end + 3;
			out += ' ';
			continue;
		}
		const close = lower.indexOf('>', open);
		if (close === -1) return out;
		const tag = /^<\/?([a-z][a-z0-9]*)/.exec(lower.slice(open, Math.min(close, open + 32)));
		const name = tag?.[1] ?? '';
		const closing = lower[open + 1] === '/';
		at = close + 1;
		if (!closing && DROPPED.has(name)) {
			const end = lower.indexOf(`</${name}`, at);
			if (end === -1) return out + ' ';
			const gt = lower.indexOf('>', end);
			at = gt === -1 ? lower.length : gt + 1;
			out += ' ';
		} else if (name === 'br' || (closing && BREAKS.has(name))) {
			out += '\n';
		} else {
			out += ' ';
		}
	}
}

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
		if (entity[0] === '#') {
			const code =
				entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: whole;
		}
		return NAMED[entity.toLowerCase()] ?? whole;
	});
}
