/**
 * Short notices stacked at the corner of the shell: an import that
 * finished, an error worth a sentence. Each toast goes away on its own
 * unless the user is meant to act on it.
 */
import type { ResolvedPathname } from '$app/types';

export interface Toast {
	id: number;
	tone: 'neutral' | 'ok' | 'danger' | 'accent';
	label: string;
	message: string;
	action?: { label: string; href: ResolvedPathname };
}

export const TOAST_MS = 10_000;

class Toasts {
	items = $state<Toast[]>([]);
	private seq = 0;
	private timers = new Map<number, ReturnType<typeof setTimeout>>();

	push(toast: Omit<Toast, 'id'>, ttl: number = TOAST_MS): number {
		const id = ++this.seq;
		this.items = [...this.items, { id, ...toast }];
		if (ttl > 0)
			this.timers.set(
				id,
				setTimeout(() => this.dismiss(id), ttl)
			);
		return id;
	}

	dismiss(id: number): void {
		const timer = this.timers.get(id);
		if (timer !== undefined) clearTimeout(timer);
		this.timers.delete(id);
		this.items = this.items.filter((t) => t.id !== id);
	}

	clear(): void {
		for (const id of [...this.timers.keys()]) this.dismiss(id);
		this.items = [];
	}
}

export const toasts = new Toasts();
