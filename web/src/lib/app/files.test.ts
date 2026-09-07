import { describe, expect, it } from 'vitest';
import { safeName } from './files';

describe('safeName', () => {
	it('replaces path and control characters and never returns an empty name', () => {
		expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd');
		expect(safeName('report:2026?.pdf')).toBe('report_2026_.pdf');
		expect(safeName('a b\tc')).toBe('a_b_c');
		expect(safeName('')).toBe('attachment');
		expect(safeName('..')).toBe('attachment');
		expect(safeName('x'.repeat(300))).toHaveLength(200);
	});
});
