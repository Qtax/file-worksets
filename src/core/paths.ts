/**
 * Helpers for workspace-relative paths. Stored paths always use `/` as the
 * separator, never start with `/` or a drive letter, and never contain `.` or
 * `..` segments, so they cannot escape their workspace folder.
 */

export function sanitizeRelativePath(input: unknown): string | undefined {
	if (typeof input !== 'string') {
		return undefined;
	}
	let path = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	while (path.startsWith('./')) {
		path = path.slice(2);
	}
	if (path.endsWith('/')) {
		path = path.slice(0, -1);
	}
	if (path === '' || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
		return undefined;
	}
	if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
		return undefined;
	}
	return path;
}

/**
 * Returns `targetPath` relative to `rootPath` (both URI paths such as `/c:/repo/src`),
 * or undefined when the target is not strictly inside the root.
 */
export function relativeUriPath(rootPath: string, targetPath: string, ignoreCase: boolean): string | undefined {
	let root = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
	let comparableRoot = ignoreCase ? root.toLowerCase() : root;
	let comparableTarget = ignoreCase ? targetPath.toLowerCase() : targetPath;
	if (!comparableTarget.startsWith(`${comparableRoot}/`)) {
		return undefined;
	}
	return sanitizeRelativePath(targetPath.slice(root.length + 1));
}

export function isSameOrUnder(path: string, ancestor: string): boolean {
	return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

export function replacePrefix(path: string, from: string, to: string): string | undefined {
	if (!isSameOrUnder(path, from)) {
		return undefined;
	}
	if (path === from) {
		return to;
	}
	return from === '' ? `${to}/${path}` : `${to}${path.slice(from.length)}`;
}

export function baseName(path: string): string {
	let index = path.lastIndexOf('/');
	return index === -1 ? path : path.slice(index + 1);
}

export function compareNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}
