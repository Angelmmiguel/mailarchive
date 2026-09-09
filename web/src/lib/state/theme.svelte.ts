/**
 * The colour theme. A preference of this device rather than of the archive,
 * so it lives in localStorage and not in the manifest, and it applies before
 * unlock too. `system` follows the browser's own setting between light and
 * dark; whichever look results is set on the document as `data-theme`, so
 * the stylesheet knows only the looks and nothing about how one was chosen.
 */
export type Look = 'light' | 'paper' | 'slate' | 'dusk' | 'dark' | 'midnight' | 'forest';
export type Theme = 'system' | Look;

export const THEMES: readonly { id: Theme; label: string }[] = [
	{ id: 'system', label: 'System' },
	{ id: 'light', label: 'Light' },
	{ id: 'paper', label: 'Paper' },
	{ id: 'slate', label: 'Slate' },
	{ id: 'dusk', label: 'Dusk' },
	{ id: 'dark', label: 'Dark' },
	{ id: 'midnight', label: 'Midnight' },
	{ id: 'forest', label: 'Forest' }
];

export const THEME_KEY = 'mailarchive.theme';

export interface ThemeDeps {
	/** Where the choice is kept, or null when the browser refuses storage. */
	storage: () => Storage | null;
	prefersDark: () => boolean;
	/** Calls `listener` whenever the browser's preference changes. */
	onPreferenceChange: (listener: () => void) => void;
	/** Sets the look on the document. */
	paint: (look: Look) => void;
}

const browserDeps: ThemeDeps = {
	storage: () => {
		try {
			return window.localStorage;
		} catch {
			return null;
		}
	},
	prefersDark: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
	onPreferenceChange: (listener) =>
		window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', listener),
	paint: (look) => {
		document.documentElement.dataset.theme = look;
	}
};

class ThemeState {
	choice = $state<Theme>('system');
	private deps: ThemeDeps = browserDeps;

	/** Reads the stored choice and paints it. Once per page load. */
	start(deps: ThemeDeps = browserDeps): void {
		this.deps = deps;
		this.choice = stored(deps.storage);
		deps.onPreferenceChange(() => {
			if (this.choice === 'system') this.paint();
		});
		this.paint();
	}

	choose(theme: Theme): void {
		this.choice = theme;
		try {
			const storage = this.deps.storage();
			if (theme === 'system') storage?.removeItem(THEME_KEY);
			else storage?.setItem(THEME_KEY, theme);
		} catch {
			// The choice still holds for this page load.
		}
		this.paint();
	}

	/** The look on screen: the choice, or what the browser prefers. */
	get look(): Look {
		if (this.choice !== 'system') return this.choice;
		return this.deps.prefersDark() ? 'dark' : 'light';
	}

	private paint(): void {
		this.deps.paint(this.look);
	}
}

function stored(storage: ThemeDeps['storage']): Theme {
	try {
		const value = storage()?.getItem(THEME_KEY);
		return THEMES.some((t) => t.id === value && value !== 'system') ? (value as Theme) : 'system';
	} catch {
		return 'system';
	}
}

export const theme = new ThemeState();
