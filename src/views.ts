import * as vscode from 'vscode';
import { describeWorkset, sortedWorksets, type WorksetActions } from './actions.ts';
import { formatRelativeTime, sameRoot, sanitizeEntries, worksetLabel, type WorksetEntry } from './core/model.ts';
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

/** "Workset Files": the files of the active workset, grouped by folder like the Explorer. */
export class ActiveFilesProvider implements vscode.TreeDataProvider<FileNode>, vscode.TreeDragAndDropController<FileNode> {
	readonly dropMimeTypes = [ENTRIES_MIME, URI_LIST];
	readonly dragMimeTypes = [ENTRIES_MIME, URI_LIST];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly store: WorksetStore;
	private readonly tree: FileTreeService;
	private readonly actions: WorksetActions;
	private readonly roots: WorkspaceRoots;
	private readonly parents = new Map<string, FileNode | undefined>();
	private loaded = false;

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

	getTreeItem(node: FileNode): vscode.TreeItem {
		return this.tree.toTreeItem(node);
	}

	async getChildren(node?: FileNode): Promise<FileNode[]> {
		// While loading, VS Code shows its progress bar instead of the empty-view message.
		await this.store.ready;
		let active = this.store.active;
		if (!active) {
			this.markRootLoaded(node);
			return [];
		}
		let children = await this.tree.getChildren('active', active.id, node);
		for (let child of children) {
			this.parents.set(nodeId(child), node);
		}
		this.markRootLoaded(node);
		return children;
	}

	private markRootLoaded(node: FileNode | undefined): void {
		if (!node && !this.loaded) {
			this.loaded = true;
			markLoaded('fileWorksets.filesLoaded');
		}
	}

	/** Required by `TreeView.reveal`. Parents are recorded as children are listed. */
	getParent(node: FileNode): FileNode | undefined {
		return this.parents.get(nodeId(node));
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
			let next = (await this.getChildren(parent)).find(matches);
			if (!next || (next.origin !== 'root' && next.path === location.path)) {
				return next;
			}
			if (!next.isDirectory) {
				return undefined;
			}
			parent = next;
		}
	}

	handleDrag(source: readonly FileNode[], dataTransfer: vscode.DataTransfer): void {
		setDragData(source, dataTransfer, this.actions);
	}

	async handleDrop(_target: FileNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		let payload = await payloadFrom(dataTransfer);
		if (payload) {
			let activeId = this.store.active?.id;
			if (payload.sources.every((id) => id === activeId)) {
				this.actions.reportAlreadyIn(this.store.active);
				return;
			}
			let workset = await this.actions.ensureActive();
			if (workset) {
				this.actions.addEntriesTo(workset, payload.entries);
			}
			return;
		}
		let uris = await urisFrom(dataTransfer);
		if (uris.length) {
			await this.actions.addUris(uris);
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

/** "File Worksets": every saved workset; expand one to browse its files. */
export class WorksetsProvider implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
	readonly dropMimeTypes = [ENTRIES_MIME, URI_LIST];
	readonly dragMimeTypes = [ENTRIES_MIME, URI_LIST];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly store: WorksetStore;
	private readonly tree: FileTreeService;
	private readonly actions: WorksetActions;
	private loaded = false;

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
			tooltip.appendMarkdown(`**${name.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')}**${isActive ? ' (active)' : ''}\n\n`);
			if (!workset.name) {
				tooltip.appendMarkdown('Unnamed. Press F2 or right-click to rename.  \n');
			}
			tooltip.appendMarkdown(`${describeWorkset(workset)}  \n`);
			tooltip.appendMarkdown(`Created ${formatRelativeTime(workset.createdAt)}  \n`);
			tooltip.appendMarkdown(`Last used ${formatRelativeTime(this.store.lastUsedTimes[workset.id])}`);
			item.tooltip = tooltip;
		}
		if (!isActive) {
			item.command = { command: 'fileWorksets.activateWorkset', title: 'Activate Workset', arguments: [node] };
		}
		return item;
	}

	async getChildren(node?: TreeNode): Promise<TreeNode[]> {
		await this.store.ready;
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
		if (payload && targetId !== undefined && payload.sources.every((id) => id === targetId)) {
			this.actions.reportAlreadyIn(this.store.get(targetId));
			return;
		}
		let uris = payload ? [] : await urisFrom(dataTransfer);
		if (!payload?.entries.length && !uris.length) {
			return;
		}
		// Dropping on empty space creates a new workset from the dropped items.
		let workset = targetId ? this.store.get(targetId) : await this.actions.createWorkset();
		if (!workset) {
			return;
		}
		if (payload) {
			this.actions.addEntriesTo(workset, payload.entries);
		} else {
			await this.actions.addUris(uris, workset);
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
