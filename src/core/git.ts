/**
 * Pure helpers for the Git integration (see GIT-INTEGRATION.md). The VS Code Git API's `Status` is a
 * `const enum` in its typings, which esbuild can't inline, so the values used here are copied.
 */

/** `Status` values from the Git API that mean the file is gone after the change. */
const DELETED_STATUSES: ReadonlySet<number> = new Set([
	2, // INDEX_DELETED
	6, // DELETED
	15, // DELETED_BY_US
	16, // DELETED_BY_THEM
	18, // BOTH_DELETED
]);

/** Git's well-known empty tree, the "parent" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Base branch candidates in order; `origin/HEAD` is the remote's default branch. */
const BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'];

/** Adding more than this many files at once asks for confirmation first. */
export const CONFIRM_ABOVE = 200;

/**
 * How the commit picker reacts to typed text. A typed or pasted hash (4+ hex digits) shows the
 * listed commits it identifies, which the picker's own filter misses since it only sees short hashes.
 * Other text without spaces could be a ref (tag, branch, `HEAD~2`), so a "Use" entry is offered.
 */
export function commitPickerMatches(typed: string, hashes: readonly string[]): { hashMatches: string[]; offerRef: boolean } {
	let text = typed.trim().toLowerCase();
	if (!text || /\s/.test(text)) {
		return { hashMatches: [], offerRef: false };
	}
	let hashMatches = text.length >= 4 && /^[0-9a-f]+$/.test(text) ? hashes.filter((hash) => hash.toLowerCase().startsWith(text)) : [];
	return { hashMatches, offerRef: hashMatches.length === 0 };
}

export interface ChangeLike<T> {
	readonly uri: T;
	readonly renameUri?: T | undefined;
	readonly status: number;
}

/** Files that exist after the changes: deletions dropped, renames mapped to the new path. */
export function changedFiles<T>(changes: readonly ChangeLike<T>[]): T[] {
	return changes.filter((change) => !DELETED_STATUSES.has(change.status)).map((change) => change.renameUri ?? change.uri);
}

/**
 * Picks the base branch of `current` from the available ref names (e.g. `main`, `origin/main`).
 * The current branch itself is never its own base.
 */
export function detectBaseBranch(refNames: Iterable<string>, current: string | undefined): string | undefined {
	let available = new Set(refNames);
	return BASE_CANDIDATES.find((name) => available.has(name) && name !== current);
}

/** The branch name as a workset name, if it's free (names are unique, ignoring case). */
export function branchWorksetName(branch: string, existingNames: Iterable<string>): string {
	let taken = new Set([...existingNames].map((name) => name.toLowerCase()));
	return taken.has(branch.toLowerCase()) ? '' : branch;
}

/** Extracts a commit hash from a Timeline item or similar argument (`ref` or `id`). */
export function commitFromArg(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	let { ref, id } = value as { ref?: unknown; id?: unknown };
	for (let candidate of [ref, id]) {
		if (typeof candidate === 'string' && /^[0-9a-f]{7,64}$/i.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** MIME type VS Code's Source Control graph uses when dragging commits. */
export const HISTORY_ITEM_MIME = 'scm-history-item';
/** URI scheme of the graph's commit URIs, which also arrive in `text/uri-list` drops. */
export const HISTORY_ITEM_SCHEME = 'scm-history-item';

/** A commit dragged or right-clicked in the graph, with its repository's root path if known. */
export interface HistoryItemRef {
	readonly commit: string;
	readonly rootPath?: string;
}

function isHash(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);
}

/**
 * Reads a graph commit URI: `scm-history-item:<repository root path>?{"historyItemId": "<hash>", ...}`.
 * `path` and `query` are the URI's decoded parts.
 */
export function parseHistoryItemUri(path: string, query: string): HistoryItemRef | undefined {
	try {
		let data = JSON.parse(query) as { historyItemId?: unknown };
		return isHash(data.historyItemId) ? { commit: data.historyItemId, ...(path ? { rootPath: path } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

/** Reads the graph's drag payload: `[{ resource, historyItem: { id, parentIds, ... } }]`. */
export function parseHistoryItemDrag(text: string): HistoryItemRef[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) {
		return [];
	}
	let result: HistoryItemRef[] = [];
	for (let item of data) {
		let { resource, historyItem } = (item ?? {}) as { resource?: { path?: unknown }; historyItem?: { id?: unknown } };
		if (isHash(historyItem?.id)) {
			let rootPath = typeof resource?.path === 'string' && resource.path ? resource.path : undefined;
			result.push({ commit: historyItem.id, ...(rootPath ? { rootPath } : {}) });
		}
	}
	return result;
}

/** Commit hashes from graph menu arguments: history items (`{ id, parentIds }`), possibly in arrays. */
export function historyItemCommits(args: readonly unknown[]): string[] {
	let commits = new Set<string>();
	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
		} else if (typeof value === 'object' && value !== null) {
			let { id, parentIds } = value as { id?: unknown; parentIds?: unknown };
			if (isHash(id) && Array.isArray(parentIds)) {
				commits.add(id);
			}
		}
	};
	args.forEach(visit);
	return [...commits];
}
