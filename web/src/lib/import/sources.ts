/**
 * Turning what the user picked or dropped into a flat list of .eml files
 * with the path they had, for the failure list. Folders dropped from a
 * file manager arrive as directory entries and are walked; anything that
 * is not an .eml is left out without comment.
 */
export interface ImportFile {
	file: File;
	/** Path relative to what was chosen, or the file name. */
	path: string;
}

export function isEml(name: string): boolean {
	return /\.eml$/i.test(name);
}

/** Files from an `<input type="file">`, with or without `webkitdirectory`. */
export function fromFileList(list: ArrayLike<File>): ImportFile[] {
	const out: ImportFile[] = [];
	for (const file of Array.from(list)) {
		if (!isEml(file.name)) continue;
		out.push({ file, path: file.webkitRelativePath || file.name });
	}
	return out;
}

/** Files from a drop, walking folders where the browser lets us. */
export async function fromDataTransfer(transfer: DataTransfer): Promise<ImportFile[]> {
	const entries: FileSystemEntry[] = [];
	for (const item of Array.from(transfer.items)) {
		const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
		if (entry !== null) entries.push(entry);
	}
	if (entries.length === 0) return fromFileList(transfer.files);
	const out: ImportFile[] = [];
	for (const entry of entries) await walk(entry, '', out);
	return out;
}

async function walk(entry: FileSystemEntry, dir: string, out: ImportFile[]): Promise<void> {
	if (entry.isFile) {
		if (!isEml(entry.name)) return;
		const file = await new Promise<File>((resolve, reject) =>
			(entry as FileSystemFileEntry).file(resolve, reject)
		);
		out.push({ file, path: dir + entry.name });
		return;
	}
	if (!entry.isDirectory) return;
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject)
		);
		if (batch.length === 0) break;
		for (const child of batch) await walk(child, `${dir}${entry.name}/`, out);
	}
}

/** A label for the run: the folder that was chosen, or the file count. */
export function describeSelection(files: ImportFile[]): string {
	const first = files[0];
	if (first === undefined) return 'nothing';
	const top = first.path.split('/')[0];
	if (
		files.length > 1 &&
		first.path.includes('/') &&
		files.every((f) => f.path.startsWith(`${top}/`))
	) {
		return `${top}/`;
	}
	return files.length === 1 ? first.path : `${files.length} files`;
}
