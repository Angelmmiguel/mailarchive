/**
 * HTML bodies for display. Messages are stored as sent and cleaned here,
 * every time, so a stricter rule later applies to old mail too. Scripts,
 * forms and embedded documents go; links open in a new tab without a
 * referrer. Images lose their source unless the caller resolves them: a
 * remote image is a tracking beacon, so they load only when the user asks
 * for the thread being read, and `cid:` parts come from the raw blob. CSS
 * can fetch too, through `url()` in a background or a border image, so
 * style attributes and elements lose their resources on the same terms.
 * The result is rendered in a shadow root under the page's
 * Content-Security-Policy, which forbids inline scripts as a second line.
 */
import DOMPurify from 'dompurify';

const FORBID_TAGS = [
	'form',
	'input',
	'button',
	'select',
	'textarea',
	'meta',
	'link',
	'base',
	'iframe',
	'object',
	'embed',
	'video',
	'audio',
	'svg',
	'math'
];
const FORBID_ATTR = ['target', 'srcset', 'ping', 'formaction', 'poster', 'background'];

/** The URL an image may load from, or null to drop it. */
export type ImageResolver = (src: string) => string | null;

/** Keeps remote and embedded images; `inline` maps a content id to its URL. */
export function imagesFrom(inline: ReadonlyMap<string, string>): ImageResolver {
	return (src) => {
		if (/^https?:/i.test(src) || /^data:image\//i.test(src)) return src;
		if (/^cid:/i.test(src)) return inline.get(decodeURIComponent(src.slice(4))) ?? null;
		return null;
	};
}

let resolver: ImageResolver | null = null;
let hooked = false;

export function sanitizeHtml(html: string, images: ImageResolver | null = null): string {
	if (!hooked) {
		DOMPurify.addHook('afterSanitizeAttributes', (node) => {
			if (node.tagName === 'A' && node.hasAttribute('href')) {
				node.setAttribute('target', '_blank');
				node.setAttribute('rel', 'noopener noreferrer');
			} else if (node.tagName === 'IMG' || node.tagName === 'SOURCE') {
				const src = node.getAttribute('src');
				const kept = src === null || resolver === null ? null : resolver(src.trim());
				if (kept === null) node.removeAttribute('src');
				else node.setAttribute('src', kept);
			}
		});
		DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
			if (data.attrName === 'style') data.attrValue = stripCssResources(data.attrValue, resolver);
		});
		DOMPurify.addHook('uponSanitizeElement', (node, data) => {
			if (data.tagName === 'style') {
				node.textContent = stripCssResources(node.textContent ?? '', resolver);
			}
		});
		hooked = true;
	}
	resolver = images;
	try {
		return DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			FORBID_TAGS,
			FORBID_ATTR,
			WHOLE_DOCUMENT: false
		});
	} finally {
		resolver = null;
	}
}

/** The CSS functions that make the browser fetch something. */
const RESOURCE_FUNCTIONS = new Set(['url', 'image-set', '-webkit-image-set', 'src']);

/**
 * Removes every resource a stylesheet or style attribute would load. A
 * `url()` becomes `none`, or, when the caller resolves images, what the
 * resolver makes of it, exactly as an `<img>` source. The other functions
 * take bare strings as URLs and are dropped outright. Function names are
 * matched after CSS escapes are undone, since `\75rl(` is `url(` to the
 * browser, and strings and comments are stepped over.
 */
export function stripCssResources(css: string, images: ImageResolver | null): string {
	let out = '';
	let from = 0;
	let identifier = '';
	let identifierStart = 0;
	let i = 0;
	while (i < css.length) {
		const c = css[i]!;
		if (c === '"' || c === "'") {
			i = stringEnd(css, i);
			identifier = '';
			continue;
		}
		if (c === '/' && css[i + 1] === '*') {
			const end = css.indexOf('*/', i + 2);
			i = end === -1 ? css.length : end + 2;
			identifier = '';
			continue;
		}
		if (c === '(') {
			if (RESOURCE_FUNCTIONS.has(identifier.toLowerCase())) {
				const close = parenEnd(css, i);
				out += css.slice(from, identifierStart);
				out += replacement(identifier.toLowerCase(), css.slice(i + 1, close), images);
				from = close + 1;
				i = from;
			} else {
				i++;
			}
			identifier = '';
			continue;
		}
		if (c === '\\') {
			const [char, next] = escape(css, i);
			if (identifier === '') identifierStart = i;
			identifier += char;
			i = next;
			continue;
		}
		if (/[A-Za-z0-9_-]/.test(c)) {
			if (identifier === '') identifierStart = i;
			identifier += c;
		} else {
			identifier = '';
		}
		i++;
	}
	return out + css.slice(from);
}

/** The index after the string that opens at `at`. */
function stringEnd(css: string, at: number): number {
	const quote = css[at];
	for (let i = at + 1; i < css.length; i++) {
		if (css[i] === '\\') i++;
		else if (css[i] === quote || css[i] === '\n') return i + 1;
	}
	return css.length;
}

/** The index of the parenthesis closing the one at `at`, or the end. */
function parenEnd(css: string, at: number): number {
	let depth = 0;
	for (let i = at; i < css.length; i++) {
		const c = css[i];
		if (c === '\\') i++;
		else if (c === '"' || c === "'") i = stringEnd(css, i) - 1;
		else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i;
	}
	return css.length;
}

/** Decodes the CSS escape at `at`: the character and the index after it. */
function escape(css: string, at: number): [string, number] {
	const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(at + 1, at + 7));
	if (hex === null) return [css[at + 1] ?? '', at + 2];
	const code = parseInt(hex[0], 16);
	let next = at + 1 + hex[0].length;
	if (/\s/.test(css[next] ?? '')) next++;
	return [code === 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code), next];
}

function replacement(name: string, argument: string, images: ImageResolver | null): string {
	if (name !== 'url' || images === null) return 'none';
	const kept = images(unquote(argument.trim()));
	return kept === null ? 'none' : `url(${JSON.stringify(kept)})`;
}

function unquote(value: string): string {
	const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
	const raw = quoted === null ? value : quoted[2]!;
	let out = '';
	for (let i = 0; i < raw.length;) {
		if (raw[i] === '\\') {
			const [char, next] = escape(raw, i);
			out += char;
			i = next;
		} else {
			out += raw[i];
			i++;
		}
	}
	return out;
}
