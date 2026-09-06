import { describe, expect, it } from 'vitest';
import { returnPath, unlockUrl } from './navigation';

describe('returnPath', () => {
	it('keeps a path inside the app, query and hash included', () => {
		expect(returnPath('/t/abc?q=budget#m2')).toBe('/t/abc?q=budget#m2');
	});

	it.each([null, '', 'settings', 'https://evil.example/', '//evil.example', '/\\evil', '/a b'])(
		'falls back to the archive for %j',
		(next) => {
			expect(returnPath(next)).toBe('/');
		}
	);
});

describe('unlockUrl', () => {
	it('omits what is not needed', () => {
		expect(unlockUrl('/')).toBe('/unlock');
	});

	it('carries the reason and the location', () => {
		expect(unlockUrl('/t/abc?q=x', 'expired')).toBe(
			'/unlock?reason=expired&next=%2Ft%2Fabc%3Fq%3Dx'
		);
	});
});
