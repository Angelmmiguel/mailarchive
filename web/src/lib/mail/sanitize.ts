/**
 * HTML bodies for display. Messages are stored as sent and cleaned here,
 * every time, so a stricter rule later applies to old mail too. Scripts,
 * forms and embedded documents go; links open in a new tab without a
 * referrer. Images lose their source unless the caller resolves them: a
 * remote image is a tracking beacon, so they load only when the user asks
 * for the thread being read, and `cid:` parts come from the raw blob. The
 * result is rendered in a shadow root under the page's
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
