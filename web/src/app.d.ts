// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface Window {
		/**
		 * The File System Access API's folder picker, which the DOM typings
		 * leave out because only Chromium browsers have it. Settings checks
		 * for it before offering the export.
		 */
		showDirectoryPicker(options?: {
			mode?: 'read' | 'readwrite';
		}): Promise<FileSystemDirectoryHandle>;
	}
}

export {};
