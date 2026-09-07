/**
 * The date chip's presets: a handful of ranges the archive can be narrowed
 * to, each spelled as `after:`/`before:` so that the box shows what the
 * chip did and a typed range shows on the chip.
 */
import { formatDate, type Query } from './query';

export interface Preset {
	id: string;
	label: string;
	after: string | null;
	before: string | null;
}

const DAY = 86_400_000;

/** Any time, the last 30 days, the last 12 months and each year present. */
export function presets(years: number[], now: number = Date.now()): Preset[] {
	const today = Math.floor(now / DAY) * DAY;
	const yearAgo = new Date(today);
	yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
	const list: Preset[] = [
		{ id: 'any', label: 'Any time', after: null, before: null },
		{ id: '30d', label: 'Last 30 days', after: formatDate(today - 30 * DAY), before: null },
		{ id: '12m', label: 'Last 12 months', after: formatDate(yearAgo.getTime()), before: null }
	];
	for (const year of [...years].sort((a, b) => b - a)) {
		list.push({
			id: String(year),
			label: String(year),
			after: String(year),
			before: String(year + 1)
		});
	}
	return list;
}

/** The preset the query's bounds spell, or null for a typed range. */
export function presetOf(query: Query, list: Preset[]): Preset | null {
	const after = query.after?.text ?? null;
	const before = query.before?.text ?? null;
	return list.find((p) => p.after === after && p.before === before) ?? null;
}

/** What the chip says: the preset, or the typed range, or nothing. */
export function rangeLabel(query: Query, list: Preset[]): string | null {
	const preset = presetOf(query, list);
	if (preset !== null) return preset.id === 'any' ? null : preset.label;
	const after = query.after?.text;
	const before = query.before?.text;
	if (after !== undefined && before !== undefined) return `${after} – ${before}`;
	if (after !== undefined) return `since ${after}`;
	if (before !== undefined) return `before ${before}`;
	return null;
}

/** The distinct years of the dated records, for the presets. */
export function yearsOf(records: Iterable<{ date: string | null }>): number[] {
	const years = new Set<number>();
	for (const record of records) {
		if (record.date === null) continue;
		const year = new Date(record.date).getUTCFullYear();
		if (!Number.isNaN(year)) years.add(year);
	}
	return [...years].sort((a, b) => b - a);
}
