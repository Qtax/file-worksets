import * as vscode from 'vscode';
import { describeWorkset, sortedWorksets, type WorksetActions } from './actions.ts';
import { HISTORY_ITEM_MIME, HISTORY_ITEM_SCHEME, parseHistoryItemDrag, parseHistoryItemUri, type HistoryItemRef } from './core/git.ts';
import {
	formatGitOrigin,
	formatRelativeTime,
	sameRoot,
	sanitizeEntries,
	worksetLabel,
	type Workset,
	type WorksetEntry,
} from './core/model.ts';
import { isSameOrUnder } from './core/paths.ts';
import { isFileNode, nodeId, type FileNode, type FileTreeService, type TreeNode, type WorksetNode } from './fileTree.ts';
import type { Location, WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

export const ACTIVE_VIEW_ID = 'fileWorksets.files';
export const LIST_VIEW_ID = 'fileWorksets.list';
/**
 * Dragged workset references. Serialized as a string because VS Code only
 * passes plain data (not tree element objects) between different views.
 */
export const ENTRIES_MIME = 'application/vnd.file-worksets.entries+json';
const URI_LIST = 'text/uri-list';

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/**
 * Sets a context key once a view has delivered its first items. Empty-view messages wait for it:
 * VS Code treats a tree as empty until its items arrive, so they'd otherwise flash while loading.
 * The short delay lets the items reach the view before the key does.
 */
function markLoaded(key: string): void {
	setTimeout(() => void vscode.commands.executeCommand('setContext', key, true), 100);
}

interface DragPayload {
	readonly sources: readonly string[];
	readonly entries: readonly WorksetEntry[];
}

function setDragData(nodes: readonly TreeNode[], dataTransfer: vscode.DataTransfer, actions: WorksetActions): void {
	// Only real files go into the URI list (for dropping onto editors); folders would drag in unselected siblings.
	let uris = nodes
		.filter(isFileNode)
		.filter((n) => !n.missing && !n.isDirectory)
		.map((n) => n.uri.toString());
	if (uris.length) {
		dataTransfer.set(URI_LIST, new vscode.DataTransferItem(uris.join('\r\n')));
	}
	let payload: DragPayload = {
		sources: [...new Set(nodes.map((n) => (isFileNode(n) ? n.worksetId : n.id)))],
		entries: actions.entriesFromNodes(nodes),
	};
	dataTransfer.set(ENTRIES_MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
}

async function payloadFrom(dataTransfer: vscode.DataTransfer): Promise<DragPayload | undefined> {
	let text = await dataTransfer.get(ENTRIES_MIME)?.asString();
	if (!text) {
		return undefined;
	}
	try {
		let data = JSON.parse(text) as { sources?: unknown; entries?: unknown };
		let sources = Array.isArray(data.sources) ? data.sources.filter((s): s is string => typeof s === 'string') : [];
		return { sources, entries: sanitizeEntries(data.entries) };
	} catch {
		return undefined;
	}
}

async function urisFrom(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
	let text = await dataTransfer.get(URI_LIST)?.asString();
	if (!text) {
		return [];
	}
	let uris: vscode.Uri[] = [];
	for (let line of text.split(/\r?\n/)) {
		let trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		try {
			uris.push(vscode.Uri.parse(trimmed, true));
		} catch {
			// ignore malformed entries
		}
	}
	return uris;
}

/**
 * Commits dragged from the Source Control graph: its own payload, or its commit URIs in the URI list.
 * Those URIs are removed from `uris`, since they aren't files.
 */
async function commitsFrom(dataTransfer: vscode.DataTransfer, uris: vscode.Uri[]): Promise<HistoryItemRef[]> {
	let fromGraph = commitUris(uris);
	let text = await dataTransfer.get(HISTORY_ITEM_MIME)?.asString();
	let payload = text ? parseHistoryItemDrag(text) : [];
	return payload.length ? payload : fromGraph;
}

function commitUris(uris: vscode.Uri[]): HistoryItemRef[] {
	let refs: HistoryItemRef[] = [];
	for (let index = uris.length - 1; index >= 0; index--) {
		let uri = uris[index]!;
		if (uri.scheme === HISTORY_ITEM_SCHEME) {
			let ref = parseHistoryItemUri(uri.path, uri.query);
			if (ref) {
				refs.unshift(ref);
			}
			uris.splice(index, 1);
		}
	}
	return refs;
}

/** Adds dragged commits' files to a workset (the active one if undefined); set when Git is available. */
export type CommitDropHandler = (commits: readonly HistoryItemRef[], target?: Workset) => Promise<void>;

/**
 * A row shown when no workset is active or it's empty. Welcome content and `TreeView.message` aren't
 * drop targets (welcome content even hides the tree), so the hint and its buttons are tree rows instead.
 */
export interface ActionNode {
	readonly kind: 'action';
	readonly id: string;
	/** Empty for hint rows: VS Code dims the description, and labels can't be colored. */
	readonly label: string;
	readonly icon: string;
	readonly command?: string;
	readonly description?: string;
	readonly tooltip?: string;
}

export type ActiveNode = FileNode | ActionNode;

const NO_ACTIVE_TOOLTIP = 'No workset is active. Drop files or folders here, or add them from the Explorer, to create a new workset.';
const EMPTY_TOOLTIP = 'This workset is empty. Drop files or folders here, or add them from the Explorer right-click menu.';
const ADD_ACTIONS: readonly ActionNode[] = [
	{ kind: 'action', id: 'add-active', command: 'fileWorksets.addActiveEditor', label: 'Add Active Editor', icon: 'add' },
	{ kind: 'action', id: 'add-open', command: 'fileWorksets.addOpenEditors', label: 'Add All Open Editors', icon: 'files' },
];
const NO_ACTIVE_ACTIONS: readonly ActionNode[] = [
	// Thin space (U+2009) used to align the text with description row under it (fragile and probably font dependent :-/ )
	{ kind: 'action', id: 'hint', label: '  No active workset', description: '', tooltip: NO_ACTIVE_TOOLTIP, icon: 'info' },
	{ kind: 'action', id: 'hint-drop', label: '', description: 'Drop files here to create one', tooltip: NO_ACTIVE_TOOLTIP, icon: 'blank' },
	...ADD_ACTIONS,
];
const EMPTY_ACTIONS: readonly ActionNode[] = [
	// Thin space (U+2009) used to align the text with description row under it (fragile and probably font dependent :-/ )
	{ kind: 'action', id: 'empty-hint', label: '  This workset is empty', description: '', tooltip: EMPTY_TOOLTIP, icon: 'info' },
	{ kind: 'action', id: 'empty-hint-drop', label: '', description: 'Drop files here to add them', tooltip: EMPTY_TOOLTIP, icon: 'blank' },
	...ADD_ACTIONS,
];

/** "Workset": the files of the active workset, grouped by folder like the Explorer. */
export class ActiveFilesProvider implements vscode.TreeDataProvider<ActiveNode>, vscode.TreeDragAndDropController<ActiveNode> {
	readonly dropMimeTypes = [ENTRIES_MIME, URI_LIST, HISTORY_ITEM_MIME];
	readonly dragMimeTypes = [ENTRIES_MIME, URI_LIST];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly store: WorksetStore;
	private readonly tree: FileTreeService;
	private readonly actions: WorksetActions;
	private readonly roots: WorkspaceRoots;
	private readonly parents = new Map<string, FileNode | undefined>();
	private loaded = false;
	/** Current Git branch, for the "Add Files from Branch" row; undefined without a repository. */
	currentBranch: (() => string | undefined) | undefined;
	dropCommits: CommitDropHandler | undefined;

	constructor(store: WorksetStore, tree: FileTreeService, actions: WorksetActions, roots: WorkspaceRoots) {
		this.store = store;
		this.tree = tree;
		this.actions = actions;
		this.roots = roots;
	}

	refresh(): void {
		this.parents.clear();
		this.emitter.fire();
	}

	getTreeItem(node: ActiveNode): vscode.TreeItem {
		if (!isFileNode(node)) {
			let item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.id = `action:${node.id}`;
			item.iconPath = new vscode.ThemeIcon(node.icon);
			item.description = node.description;
			item.tooltip = node.tooltip;
			if (node.command) {
				item.command = { command: node.command, title: node.label };
			}
			item.contextValue = 'action';
			return item;
		}
		return this.tree.toTreeItem(node);
	}

	async getChildren(node?: ActiveNode): Promise<ActiveNode[]> {
		if (node && !isFileNode(node)) {
			return [];
		}
		let children: ActiveNode[] = await this.children(node);
		if (!node && children.length === 0 && this.store.hasStorage) {
			children = [...(this.store.active ? EMPTY_ACTIONS : NO_ACTIVE_ACTIONS)];
			let branch = this.currentBranch?.();
			if (branch) {
				children.push({
					kind: 'action',
					id: 'add-branch',
					command: 'fileWorksets.addBranchFiles',
					label: 'Add Files from Branch',
					description: branch,
					tooltip: `Add the files committed on ${branch} since it left its base branch`,
					icon: 'git-branch',
				});
			}
		}
		// Only VS Code's own requests count as "loaded"; internal lookups (auto-reveal) don't render anything.
		if (!node && !this.loaded) {
			this.loaded = true;
			markLoaded('fileWorksets.filesLoaded');
		}
		return children;
	}

	private async children(node?: FileNode): Promise<FileNode[]> {
		// While loading, VS Code shows its progress bar instead of the empty-view message.
		await this.store.whenLoaded();
		let active = this.store.active;
		if (!active) {
			return [];
		}
		let children = await this.tree.getChildren('active', active.id, node);
		for (let child of children) {
			this.parents.set(nodeId(child), node);
		}
		return children;
	}

	/** Required by `TreeView.reveal`. Parents are recorded as children are listed. */
	getParent(node: ActiveNode): FileNode | undefined {
		return isFileNode(node) ? this.parents.get(nodeId(node)) : undefined;
	}

	/**
	 * Finds the item showing `location` by walking down from the root, so compact folders and
	 * folder entries resolve the same way they're displayed. Undefined if it isn't in the workset.
	 */
	async findNode(location: Location): Promise<FileNode | undefined> {
		let defaultRoot = this.roots.defaultRoot();
		let folderIndex = this.roots.resolve(location.root)?.index;
		let matches = (child: FileNode): boolean =>
			child.origin === 'root'
				? this.roots.resolve(child.root)?.index === folderIndex
				: sameRoot(child.root, location.root, defaultRoot) && isSameOrUnder(location.path, child.path);
		let parent: FileNode | undefined;
		while (true) {
			let next = (await this.children(parent)).find(matches);
			if (!next || (next.origin !== 'root' && next.path === location.path)) {
				return next;
			}
			if (!next.isDirectory) {
				return undefined;
			}
			parent = next;
		}
	}

	handleDrag(source: readonly ActiveNode[], dataTransfer: vscode.DataTransfer): void {
		let files = source.filter(isFileNode);
		if (files.length) {
			setDragData(files, dataTransfer, this.actions);
		}
	}

	async handleDrop(_target: ActiveNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		let payload = await payloadFrom(dataTransfer);
		if (payload) {
			let activeId = this.store.active?.id;
			if (payload.sources.length > 0 && payload.sources.every((id) => id === activeId)) {
				this.actions.reportAlreadyIn(this.store.active);
				return;
			}
			if (payload.entries.length === 0) {
				return;
			}
			let workset = await this.actions.ensureActive();
			if (workset) {
				this.actions.addEntriesTo(workset, payload.entries);
			}
			return;
		}
		let uris = await urisFrom(dataTransfer);
		let commits = await commitsFrom(dataTransfer, uris);
		if (commits.length && this.dropCommits) {
			await this.dropCommits(commits);
		}
		if (uris.length) {
			await this.actions.addUris(uris);
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

/** "Worksets": every saved workset; expand one to browse its files. */
export class WorksetsProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
	readonly dropMimeTypes = [ENTRIES_MIME, URI_LIST, HISTORY_ITEM_MIME];
	readonly dragMimeTypes = [ENTRIES_MIME, URI_LIST];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly store: WorksetStore;
	private readonly tree: FileTreeService;
	private readonly actions: WorksetActions;
	private loaded = false;
	dropCommits: CommitDropHandler | undefined;

	constructor(store: WorksetStore, tree: FileTreeService, actions: WorksetActions) {
		this.store = store;
		this.tree = tree;
		this.actions = actions;
	}

	refresh(): void {
		this.emitter.fire();
	}

	getTreeItem(node: TreeNode): vscode.TreeItem {
		if (isFileNode(node)) {
			return this.tree.toTreeItem(node);
		}
		let workset = this.store.get(node.id);
		let isActive = this.store.active?.id === node.id;
		let name = workset ? worksetLabel(workset) : '';
		let item = new vscode.TreeItem(
			isActive ? { label: name, highlights: [[0, name.length]] } : name,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.id = `workset:${node.id}`;
		item.iconPath = new vscode.ThemeIcon(isActive ? 'pass-filled' : 'circle-large-outline');
		item.description = workset ? `${isActive ? 'active · ' : ''}${describeWorkset(workset)}` : '';
		item.contextValue = isActive ? 'workset.active' : 'workset';
		if (workset) {
			let tooltip = new vscode.MarkdownString();
			tooltip.appendMarkdown(`**${escapeMarkdown(name)}**${isActive ? ' (active)' : ''}\n\n`);
			tooltip.appendMarkdown(`${describeWorkset(workset)}  \n`);
			tooltip.appendMarkdown(`Created ${formatRelativeTime(workset.createdAt)}`);
			if (workset.git) {
				tooltip.appendMarkdown(` on ${escapeMarkdown(formatGitOrigin(workset.git))}`);
			}
			tooltip.appendMarkdown('  \n');
			tooltip.appendMarkdown(`Last used ${formatRelativeTime(this.store.lastUsedTimes[workset.id])}`);
			item.tooltip = tooltip;
		}
		if (!isActive) {
			item.command = { command: 'fileWorksets.activateWorkset', title: 'Activate Workset', arguments: [node] };
		}
		return item;
	}

	async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		await this.store.whenLoaded();
		if (!node) {
			if (!this.loaded) {
				this.loaded = true;
				markLoaded('fileWorksets.listLoaded');
			}
			return sortedWorksets(this.store).map((w): WorksetNode => ({ kind: 'workset', id: w.id }));
		}
		return isFileNode(node)
			? this.tree.getChildren('list', node.worksetId, node)
			: this.tree.getChildren('list', node.id);
	}

	handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
		setDragData(source, dataTransfer, this.actions);
	}

	async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		let targetId = target === undefined ? undefined : isFileNode(target) ? target.worksetId : target.id;
		let payload = await payloadFrom(dataTransfer);
		if (payload && targetId !== undefined && payload.sources.length > 0 && payload.sources.every((id) => id === targetId)) {
			this.actions.reportAlreadyIn(this.store.get(targetId));
			return;
		}
		let uris = payload ? [] : await urisFrom(dataTransfer);
		let commits = payload || !this.dropCommits ? [] : await commitsFrom(dataTransfer, uris);
		if (!payload?.entries.length && !uris.length && !commits.length) {
			return;
		}
		// Dropping on empty space creates a new workset from the dropped items.
		let workset = targetId ? this.store.get(targetId) : await this.actions.createWorkset();
		if (!workset) {
			return;
		}
		if (commits.length) {
			await this.dropCommits?.(commits, workset);
		}
		if (payload) {
			this.actions.addEntriesTo(workset, payload.entries);
		} else if (uris.length) {
			await this.actions.addUris(uris, workset);
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
