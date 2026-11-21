import * as vscode from 'vscode';
import { compileExcludes } from './core/glob.ts';
import { coveringFolder, type Workset } from './core/model.ts';
import {
	buildTrie,
	compareTreeItems,
	findNode,
	isDirectoryNode,
	listChildren,
	type ExplorerSortOrder,
	type LexicographicOrder,
	type SortItem,
	type SortOptions,
	type TrieNode,
} from './core/tree.ts';
import { joinPath, type WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

export const MISSING_QUERY = 'file-worksets-missing';

export type ViewKind = 'active' | 'list';

/**
 * - `root`: workspace folder (multi-root only)
 * - `file` / `folder`: explicit workset entries
 * - `implicit`: folder shown only because it leads to an entry
 * - `dynamicFile` / `dynamicFolder`: on-disk contents of a folder entry
 */
export type NodeOrigin = 'root' | 'file' | 'folder' | 'implicit' | 'dynamicFile' | 'dynamicFolder';

export interface FileNode {
	readonly kind: 'file-node';
	readonly view: ViewKind;
	readonly worksetId: string;
	readonly root: string | undefined;
	readonly path: string;
	readonly label: string;
	readonly origin: NodeOrigin;
	readonly isDirectory: boolean;
	readonly uri: vscode.Uri;
	readonly missing: boolean;
}

export interface WorksetNode {
	readonly kind: 'workset';
	readonly id: string;
}

export type TreeNode = FileNode | WorksetNode;

export function isFileNode(value: unknown): value is FileNode {
	return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'file-node';
}

/** Stable tree item ID; VS Code uses it to match items across refreshes and in `reveal`. */
export function nodeId(node: FileNode): string {
	return `${node.view}:${node.worksetId}:${node.root ?? ''}:${node.path}`;
}

export function isWorksetNode(value: unknown): value is WorksetNode {
	return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'workset';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return [];
	}
}

/** The Explorer settings this tree follows, so both trees look and sort the same. They're window-scoped. */
function explorerSettings(): { compact: boolean; sort: SortOptions } {
	let config = vscode.workspace.getConfiguration('explorer');
	return {
		compact: config.get<boolean>('compactFolders', true),
		sort: {
			order: config.get<ExplorerSortOrder>('sortOrder', 'default'),
			lexicographic: config.get<LexicographicOrder>('sortOrderLexicographicOptions', 'default'),
		},
	};
}

/**
 * Like the Explorer, compact folder labels use the platform's separator for local files. Thin spaces
 * (U+2009) stand in for the Explorer's 2px margins around it; extension tree labels are plain text.
 */
function compactLabel(label: string, uri: vscode.Uri): string {
	let separator = uri.scheme === 'file' && process.platform === 'win32' ? '\\' : '/';
	return label.replaceAll('/', `\u2009${separator}\u2009`);
}

/** Builds file tree nodes for a workset from its saved references. */
export class FileTreeService {
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;

	constructor(store: WorksetStore, roots: WorkspaceRoots) {
		this.store = store;
		this.roots = roots;
	}

	async getChildren(view: ViewKind, worksetId: string, parent?: FileNode): Promise<FileNode[]> {
		let workset = this.store.get(worksetId);
		if (!workset) {
			return [];
		}
		if (!parent) {
			let folders = this.roots.folders();
			if (folders.length <= 1) {
				let folder = folders[0];
				return folder ? this.childrenOf(view, workset, folder, undefined, '', false) : [];
			}
			return folders
				.filter((folder) => workset.entries.some((e) => this.roots.resolve(e.root)?.index === folder.index))
				.map((folder) => this.node(view, workset.id, folder.name, '', folder.name, 'root', true, folder.uri, false));
		}
		if (!parent.isDirectory) {
			return [];
		}
		let folder = this.roots.resolve(parent.root);
		if (!folder) {
			return [];
		}
		let dynamic = parent.origin === 'folder' || parent.origin === 'dynamicFolder';
		return this.childrenOf(view, workset, folder, parent.root, parent.path, dynamic && !parent.missing);
	}

	private async childrenOf(
		view: ViewKind,
		workset: Workset,
		folder: vscode.WorkspaceFolder,
		root: string | undefined,
		path: string,
		dynamic: boolean,
	): Promise<FileNode[]> {
		let trie = buildTrie(workset.entries.filter((e) => this.roots.resolve(e.root)?.index === folder.index));
		let trieNode = findNode(trie, path);
		let explorer = explorerSettings();
		let fromTrie = async (node: TrieNode, label: string, missing?: boolean): Promise<FileNode> => {
			let isDir = isDirectoryNode(node);
			let origin: NodeOrigin = node.isFolderEntry ? 'folder' : isDir ? 'implicit' : 'file';
			let uri = joinPath(folder.uri, node.path);
			return this.node(view, workset.id, root, node.path, label, origin, isDir, uri, missing ?? !(await exists(uri)));
		};

		if (!dynamic) {
			let children = trieNode ? listChildren(trieNode, explorer.compact, explorer.sort) : [];
			return Promise.all(children.map(({ node, label }) => fromTrie(node, label)));
		}

		// Folder entries show their current on-disk contents, merged with explicit entries.
		let dirUri = joinPath(folder.uri, path);
		let excludes = compileExcludes(
			vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude'),
		);
		let isExcluded = (childPath: string): boolean => excludes.some((pattern) => pattern.test(childPath));
		let listing = await readDirectory(dirUri);
		let explicit = trieNode?.children ?? new Map<string, TrieNode>();
		let nodes: FileNode[] = [];
		let seen = new Set<string>();
		for (let [name, type] of listing) {
			let childPath = path ? `${path}/${name}` : name;
			let trieChild = explicit.get(name);
			if (!trieChild && isExcluded(childPath)) {
				continue;
			}
			seen.add(name);
			let isDir = (type & vscode.FileType.Directory) !== 0;
			let origin: NodeOrigin = trieChild?.isFolderEntry
				? 'folder'
				: trieChild?.isFile && !isDir
					? 'file'
					: isDir
						? 'dynamicFolder'
						: 'dynamicFile';
			if (origin === 'dynamicFolder' && explorer.compact && !trieChild) {
				// Like the Explorer: a folder whose only child is a folder is shown as one `a/b` item.
				let chain = await this.compactOnDisk(dirUri, childPath, name, isExcluded);
				nodes.push(this.node(view, workset.id, root, chain.path, chain.label, origin, true, joinPath(folder.uri, chain.path), false));
				continue;
			}
			nodes.push(this.node(view, workset.id, root, childPath, name, origin, isDir, joinPath(dirUri, name), false));
		}
		for (let [name, trieChild] of explicit) {
			if (!seen.has(name)) {
				nodes.push(await fromTrie(trieChild, name, true));
			}
		}
		let sortItem = (n: FileNode): SortItem => ({ isDirectory: n.isDirectory, name: n.label.split('/')[0] ?? n.label });
		return nodes.sort((a, b) => compareTreeItems(sortItem(a), sortItem(b), explorer.sort));
	}

	/** Follows single-subfolder chains on disk, e.g. `a` → `a/b/c` when `a` only contains `b`, which only contains `c`. */
	private async compactOnDisk(
		parentUri: vscode.Uri,
		path: string,
		name: string,
		isExcluded: (path: string) => boolean,
	): Promise<{ path: string; label: string }> {
		let names = [name];
		let current = path;
		let uri = vscode.Uri.joinPath(parentUri, name);
		for (let depth = 0; depth < 32; depth++) {
			let entries = (await readDirectory(uri)).filter(([child]) => !isExcluded(`${current}/${child}`));
			let [only] = entries;
			if (entries.length !== 1 || !only || (only[1] & vscode.FileType.Directory) === 0) {
				break;
			}
			names.push(only[0]);
			current = `${current}/${only[0]}`;
			uri = vscode.Uri.joinPath(uri, only[0]);
		}
		return { path: current, label: names.join('/') };
	}

	toTreeItem(node: FileNode): vscode.TreeItem {
		let state = !node.isDirectory
			? vscode.TreeItemCollapsibleState.None
			: node.origin === 'root'
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		let item = new vscode.TreeItem(compactLabel(node.label, node.uri), state);
		item.id = nodeId(node);
		// The query only affects decorations in this view; commands always use node.uri.
		item.resourceUri = node.missing ? node.uri.with({ query: MISSING_QUERY }) : node.uri;
		item.contextValue = node.missing ? `${node.origin}.missing` : node.origin;
		if (node.origin === 'folder') {
			item.description = 'entire folder';
		}
		if (node.missing) {
			item.description = node.origin === 'folder' ? 'entire folder, missing' : 'missing';
		}
		item.tooltip = this.tooltip(node);
		if (!node.isDirectory && !node.missing) {
			item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
		}
		return item;
	}

	private tooltip(node: FileNode): string {
		let display = this.roots.displayPath(node.root, node.path);
		let workset = this.store.get(node.worksetId);
		switch (node.origin) {
			case 'folder':
				return `${display}\nIncludes everything in this folder, including files added later.`;
			case 'dynamicFile':
			case 'dynamicFolder': {
				let cover = workset && coveringFolder(workset.entries, node.root, node.path, this.roots.defaultRoot());
				return cover ? `${display}\nIncluded through folder "${cover.path}".` : display;
			}
			default:
				return node.missing ? `${display}\nNot found on disk. The reference is kept in case it comes back.` : display;
		}
	}

	private node(
		view: ViewKind,
		worksetId: string,
		root: string | undefined,
		path: string,
		label: string,
		origin: NodeOrigin,
		isDirectory: boolean,
		uri: vscode.Uri,
		missing: boolean,
	): FileNode {
		return { kind: 'file-node', view, worksetId, root, path, label, origin, isDirectory, uri, missing };
	}
}

/** Greys out references whose files are missing. Only applies to URIs tagged by this view. */
export class MissingFileDecorations implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.query !== MISSING_QUERY) {
			return undefined;
		}
		return new vscode.FileDecoration('!', 'Missing on disk', new vscode.ThemeColor('list.deemphasizedForeground'));
	}
}
