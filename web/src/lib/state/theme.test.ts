import { describe, expect, it } from 'vitest';
import { theme, THEME_KEY, type Look, type ThemeDeps } from './theme.svelte';

function fake(initial: Record<string, string> = {}, dark = false) {
	const items = new Map(Object.entries(initial));
	const painted: Look[] = [];
	let listener: (() => void) | null = null;
	const preference = { dark };
	const deps: ThemeDeps = {
		storage: () =>
			({
				getItem: (key: string) => items.get(key) ?? null,
				setItem: (key: string, value: string) => void items.set(key, value),
				removeItem: (key: string) => void items.delete(key)
			}) as unknown as Storage,
		prefersDark: () => preference.dark,
		onPreferenceChange: (l) => (listener = l),
		paint: (look) => void painted.push(look)
	};
	return {
		deps,
		items,
		painted,
		preference,
		change: (): void => listener?.()
	};
}

describe('theme', () => {
	it('starts from what is stored, or from the browser', () => {
		const a = fake({}, true);
		theme.start(a.deps);
		expect(theme.choice).toBe('system');
		expect(a.painted).toEqual(['dark']);

		const b = fake({ [THEME_KEY]: 'dusk' });
		theme.start(b.deps);
		expect(theme.choice).toBe('dusk');
		expect(b.painted).toEqual(['dusk']);

		const c = fake({ [THEME_KEY]: 'neon' });
		theme.start(c.deps);
		expect(theme.choice).toBe('system');
		expect(c.painted).toEqual(['light']);
	});

	it('keeps a choice and forgets it for system', () => {
		const f = fake();
		theme.start(f.deps);
		theme.choose('dark');
		expect(f.items.get(THEME_KEY)).toBe('dark');
		expect(f.painted).toEqual(['light', 'dark']);
		theme.choose('system');
		expect(f.items.has(THEME_KEY)).toBe(false);
		expect(f.painted).toEqual(['light', 'dark', 'light']);
	});

	it('follows the browser only while set to system', () => {
		const f = fake();
		theme.start(f.deps);
		f.preference.dark = true;
		f.change();
		expect(f.painted).toEqual(['light', 'dark']);
		theme.choose('light');
		f.preference.dark = false;
		f.change();
		expect(f.painted).toEqual(['light', 'dark', 'light']);
	});

	it('holds the choice for the page when storage refuses', () => {
		const deps: ThemeDeps = {
			storage: () => {
				throw new Error('denied');
			},
			prefersDark: () => false,
			onPreferenceChange: () => {},
			paint: () => {}
		};
		theme.start(deps);
		theme.choose('dusk');
		expect(theme.choice).toBe('dusk');
		expect(theme.look).toBe('dusk');
	});
});
