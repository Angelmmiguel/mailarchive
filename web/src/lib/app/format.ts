/**
 * Dates, sizes and counts as the screens print them. Dates are shown in
 * the browser's zone: the archive is read where the user is.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `03 SEP` within the current year, `03 SEP 25` outside it; empty without a date. */
export function shortDate(iso: string | null, now: Date = new Date()): string {
	if (iso === null) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const day = `${pad(date.getDate())} ${MONTHS[date.getMonth()].toUpperCase()}`;
	return date.getFullYear() === now.getFullYear() ? day : `${day} ${pad(date.getFullYear() % 100)}`;
}

/** `Wed 02 Sep 2026, 09:41`; a placeholder without a date. */
export function longDate(iso: string | null): string {
	if (iso === null) return 'no date';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return 'no date';
	return `${DAYS[date.getDay()]} ${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `14 AUG – 02 SEP`, or one date when both are the same day. */
export function dateSpan(from: string | null, to: string | null, now: Date = new Date()): string {
	const a = shortDate(from, now);
	const b = shortDate(to, now);
	if (a === '' || b === '' || a === b) return a || b;
	return `${a} – ${b}`;
}

/** `88 B`, `310 KB`, `2.4 MB`. */
export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The badge on an attachment chip: the extension, else the MIME subtype. */
export function fileKind(name: string, type: string): string {
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 ? name.slice(dot + 1) : '';
	if (/^[a-z0-9]{1,5}$/i.test(extension)) return extension.toUpperCase();
	const subtype = type.split('/')[1]?.split(/[+;]/)[0] ?? '';
	return /^[a-z0-9-]{1,5}$/i.test(subtype) ? subtype.toUpperCase() : 'FILE';
}

/**
 * What the browser can show itself; everything else is downloaded. SVG is
 * left out on purpose: it is a document that can carry scripts, and a blob
 * URL opens it on this app's origin.
 */
export function opensInTab(type: string): boolean {
	const kind = type.split(';')[0].trim().toLowerCase();
	if (kind === 'image/svg+xml') return false;
	return kind.startsWith('image/') || kind === 'application/pdf' || kind === 'text/plain';
}

/** `1 message`, `2,400 messages`. */
export function count(n: number, one: string, many: string = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}
