import { compareNames } from './paths.ts';

/**
 * A path trie built from workset entries. Only folders that lead to an entry
 * exist in the trie, so siblings on disk are never shown.
 */
export interface TrieNode {
	readonly name: string;
	readonly path: string;
	readonly children: Map<string, TrieNode>;
	isFile: boolean;
	isFolderEntry: boolean;
}

function createNode(name: string, path: string): TrieNode {
	return { name, path, children: new Map(), isFile: false, isFolderEntry: false };
}

export function buildTrie(entries: Iterable<{ readonly kind: 'file' | 'folder'; readonly path: string }>): TrieNode {
	let root = createNode('', '');
	for (let entry of entries) {
		let node = root;
		for (let segment of entry.path.split('/')) {
			let child = node.children.get(segment);
			if (!child) {
				child = createNode(segment, node.path ? `${node.path}/${segment}` : segment);
				node.children.set(segment, child);
			}
			node = child;
		}
		if (entry.kind === 'folder') {
			node.isFolderEntry = true;
		} else {
			node.isFile = true;
		}
	}
	return root;
}

export function findNode(root: TrieNode, path: string): TrieNode | undefined {
	if (path === '') {
		return root;
	}
	let node: TrieNode | undefined = root;
	for (let segment of path.split('/')) {
		node = node.children.get(segment);
		if (!node) {
			return undefined;
		}
	}
	return node;
}

export function isDirectoryNode(node: TrieNode): boolean {
	return node.isFolderEntry || node.children.size > 0;
}

export interface TrieChild {
	readonly node: TrieNode;
	readonly label: string;
}

/**
 * Like the Explorer's compact folders: a chain of folders that each contain
 * exactly one folder is shown as a single `a/b/c` item. Folder entries stop the
 * chain because their contents come from disk.
 */
export function compactChain(start: TrieNode): TrieChild {
	let node = start;
	let names = [start.name];
	while (!node.isFolderEntry && !node.isFile && node.children.size === 1) {
		let only = node.children.values().next().value as TrieNode;
		if (!isDirectoryNode(only)) {
			break;
		}
		node = only;
		names.push(only.name);
	}
	return { node, label: names.join('/') };
}

/** Values of `explorer.sortOrder`. `modified` and `foldersNestsFiles` are treated like `default`. */
export type ExplorerSortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified' | 'foldersNestsFiles';
/** Values of `explorer.sortOrderLexicographicOptions`. */
export type LexicographicOrder = 'default' | 'upper' | 'lower' | 'unicode';

export interface SortOptions {
	readonly order: ExplorerSortOrder;
	readonly lexicographic: LexicographicOrder;
}

export const DEFAULT_SORT: SortOptions = { order: 'default', lexicographic: 'default' };

export interface SortItem {
	readonly isDirectory: boolean;
	/** For compacted folders, the first segment, which the Explorer sorts by. */
	readonly name: string;
}

function startsWithUpper(name: string): boolean {
	let first = name.charAt(0);
	return first !== first.toLowerCase() && first === first.toUpperCase();
}

function startsWithLower(name: string): boolean {
	let first = name.charAt(0);
	return first !== first.toUpperCase() && first === first.toLowerCase();
}

/** Like VS Code's `compareFileNamesUpper`/`Lower`: group by the case of the first letter, then by name. */
function compareCaseFirst(a: string, b: string, upperFirst: boolean): number {
	let aUpper = startsWithUpper(a);
	let bUpper = startsWithUpper(b);
	let aLower = startsWithLower(a);
	let bLower = startsWithLower(b);
	if (aUpper && bLower) {
		return upperFirst ? -1 : 1;
	}
	if (aLower && bUpper) {
		return upperFirst ? 1 : -1;
	}
	return 0;
}

function compareLexicographic(a: string, b: string, lexicographic: LexicographicOrder): number {
	switch (lexicographic) {
		case 'unicode':
			return a < b ? -1 : a > b ? 1 : 0;
		case 'upper':
		case 'lower':
			return compareCaseFirst(a, b, lexicographic === 'upper') || compareNames(a, b);
		default:
			return compareNames(a, b);
	}
}

function extensionOf(name: string): string {
	let dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Orders items like the Explorer for the given `explorer.sortOrder` settings. */
export function compareTreeItems(a: SortItem, b: SortItem, options: SortOptions = DEFAULT_SORT): number {
	if (a.isDirectory !== b.isDirectory && options.order !== 'mixed') {
		let filesFirst = options.order === 'filesFirst';
		return a.isDirectory === filesFirst ? 1 : -1;
	}
	if (options.order === 'type' && !a.isDirectory && !b.isDirectory) {
		let byExtension = compareLexicographic(extensionOf(a.name), extensionOf(b.name), options.lexicographic);
		if (byExtension) {
			return byExtension;
		}
	}
	return compareLexicographic(a.name, b.name, options.lexicographic);
}

export function listChildren(node: TrieNode, compact: boolean, options: SortOptions = DEFAULT_SORT): TrieChild[] {
	let sortItem = (child: TrieChild): SortItem => ({
		isDirectory: isDirectoryNode(child.node),
		name: child.label.split('/')[0] ?? child.label,
	});
	return [...node.children.values()]
		.map((child) => (compact && isDirectoryNode(child) ? compactChain(child) : { node: child, label: child.name }))
		.sort((a, b) => compareTreeItems(sortItem(a), sortItem(b), options));
}
