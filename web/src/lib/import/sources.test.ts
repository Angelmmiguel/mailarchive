import { describe, expect, it } from 'vitest';
import { describeSelection, fromFileList, isEml } from './sources';

function file(name: string, relative = ''): File {
	const f = new File(['x'], name);
	Object.defineProperty(f, 'webkitRelativePath', { value: relative });
	return f;
}

describe('fromFileList', () => {
	it('keeps .eml files, case-insensitively, with their folder path', () => {
		const files = fromFileList([
			file('a.eml'),
			file('B.EML', 'Mail/2024/B.EML'),
			file('notes.txt')
		]);

		expect(files.map((f) => f.path)).toEqual(['a.eml', 'Mail/2024/B.EML']);
	});
});

describe('describeSelection', () => {
	it('names the folder, the file or the count', () => {
		expect(describeSelection([])).toBe('nothing');
		expect(describeSelection(fromFileList([file('a.eml')]))).toBe('a.eml');
		expect(describeSelection(fromFileList([file('a.eml'), file('b.eml')]))).toBe('2 files');
		expect(
			describeSelection(fromFileList([file('a.eml', 'Mail/a.eml'), file('b.eml', 'Mail/x/b.eml')]))
		).toBe('Mail/');
	});
});

it('isEml', () => {
	expect(isEml('x.eml')).toBe(true);
	expect(isEml('x.eml.bak')).toBe(false);
});
