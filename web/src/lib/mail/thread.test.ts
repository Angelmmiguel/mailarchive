import { describe, expect, it } from 'vitest';
import { threadIdFor } from './thread';

describe('threadIdFor', () => {
	it('joins the thread of a known ancestor', () => {
		const known = new Map([['root@x', 'thread-root']]);
		const message = { messageId: 'reply@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'] };

		expect(threadIdFor(message, known, 'fallback')).toBe('thread-root');
	});

	it('names a new thread after the oldest reference when none is known', () => {
		const message = { messageId: 'reply@x', inReplyTo: 'mid@x', references: ['root@x', 'mid@x'] };

		expect(threadIdFor(message, new Map(), 'fallback')).toBe('root@x');
	});

	it('uses its own id, then the fallback', () => {
		expect(threadIdFor({ messageId: 'm@x', inReplyTo: null, references: [] }, new Map(), 'f')).toBe(
			'm@x'
		);
		expect(threadIdFor({ messageId: null, inReplyTo: null, references: [] }, new Map(), 'f')).toBe(
			'f'
		);
	});
});
