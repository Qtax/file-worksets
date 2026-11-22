import * as vscode from 'vscode';
import { asFileNodes, tabUri, WorksetActions } from './actions.ts';
import { AUTO_ADD_MODES, AutoAdder, isAutoAddMode, readAutoAddMode, type AutoAddMode } from './autoAdd.ts';
import { ActiveEditorRevealer } from './autoReveal.ts';
import { DeletionTracker } from './deletions.ts';
import { WorksetFileDecorations } from './decorations.ts';
import { touchIndex, worksetLabel, type SortOrder } from './core/model.ts';
import { FileTreeService, isFileNode, isWorksetNode, MissingFileDecorations, type FileNode, type TreeNode } from './fileTree.ts';
import { WorkspaceRoots } from './roots.ts';
import { FileStorageBackend, MementoStorageBackend, STORAGE_FILE, type StorageBackend } from './storage.ts';
import { WorksetStore } from './store.ts';
import { ACTIVE_VIEW_ID, ActiveFilesProvider, LIST_VIEW_ID, WorksetsProvider, type ActiveNode } from './views.ts';

/** Must match the view's `name` in package.json. */
const ACTIVE_VIEW_NAME = 'Workset Files';

export interface FileWorksetsApi {
	readonly store: WorksetStore;
	readonly actions: WorksetActions;
	readonly activeFiles: ActiveFilesProvider;
	readonly worksets: WorksetsProvider;
	readonly activeView: vscode.TreeView<ActiveNode>;
	readonly listView: vscode.TreeView<TreeNode>;
	readonly revealer: ActiveEditorRevealer;
	readonly decorations: WorksetFileDecorations;
}

function createBackend(context: vscode.ExtensionContext, roots: WorkspaceRoots): StorageBackend | undefined {
	let folder = roots.folders()[0];
	if (!folder) {
		roots.useSource(undefined);
		return undefined;
	}
	let location = vscode.workspace.getConfiguration('fileWorksets').get<string>('storageLocation', 'workspaceState');
	if (location === 'workspaceFolder') {
		let backend = new FileStorageBackend(folder);
		roots.useSource({ file: backend.uri, folder: folder.name });
		return backend;
	}
	roots.useSource(undefined);
	return new MementoStorageBackend(context.workspaceState, vscode.Uri.joinPath(folder.uri, ...STORAGE_FILE.split('/')));
}

function isUri(value: unknown): value is vscode.Uri {
	return value instanceof vscode.Uri;
}

/** URIs from Explorer (`uri, uris[]`), editor title (`uri`), or the active editor. */
function urisFromArgs(primary: unknown, selection: unknown): vscode.Uri[] {
	if (Array.isArray(selection) && selection.length && selection.every(isUri)) {
		return selection;
	}
	if (isUri(primary)) {
		return [primary];
	}
	let uri = tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
	return uri ? [uri] : [];
}

/**
 * Updates a `fileWorksets.*` setting where it's already defined (folder or workspace), otherwise in user
 * settings, so a workspace value doesn't silently win and the repo's settings aren't modified needlessly.
 */
async function updateSetting(key: string, value: unknown): Promise<void> {
	let config = vscode.workspace.getConfiguration('fileWorksets');
	let inspected = config.inspect(key);
	let target =
		inspected?.workspaceFolderValue !== undefined
			? vscode.ConfigurationTarget.WorkspaceFolder
			: inspected?.workspaceValue !== undefined
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
	await config.update(key, value, target);
}

function debounce(fn: () => void, ms: number): { (): void; dispose(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let debounced = (): void => {
		clearTimeout(timer);
		timer = setTimeout(fn, ms);
	};
	return Object.assign(debounced, { dispose: () => clearTimeout(timer) });
}

export async function activate(context: vscode.ExtensionContext): Promise<FileWorksetsApi> {
	let roots = new WorkspaceRoots(context.workspaceState);
	let store = new WorksetStore(context.workspaceState, roots);
	let tree = new FileTreeService(store, roots);
	let actions = new WorksetActions(store, roots);
	let activeFiles = new ActiveFilesProvider(store, tree, actions, roots);
	let worksets = new WorksetsProvider(store, tree, actions);
	let deletions = new DeletionTracker(store, roots, context.workspaceState);
	context.subscriptions.push(store, activeFiles, worksets, new AutoAdder(store, roots), deletions);

	let activeView = vscode.window.createTreeView(ACTIVE_VIEW_ID, {
		treeDataProvider: activeFiles,
		dragAndDropController: activeFiles,
		canSelectMany: true,
		showCollapseAll: true,
	});
	let listView = vscode.window.createTreeView(LIST_VIEW_ID, {
		treeDataProvider: worksets,
		dragAndDropController: worksets,
		canSelectMany: true,
		showCollapseAll: true,
	});
	let statusBar = vscode.window.createStatusBarItem('fileWorksets.active', vscode.StatusBarAlignment.Left, 50);
	statusBar.name = 'Active Workset';
	statusBar.command = 'fileWorksets.switchWorkset';
	let revealer = new ActiveEditorRevealer(activeView, activeFiles, store, roots);
	let decorations = new WorksetFileDecorations(store, roots);
	context.subscriptions.push(
		activeView,
		listView,
		statusBar,
		revealer,
		vscode.window.registerFileDecorationProvider(new MissingFileDecorations()),
		decorations,
		vscode.window.registerFileDecorationProvider(decorations),
	);

	let refreshViews = (): void => {
		activeFiles.refresh();
		worksets.refresh();
	};

	// Keeps references stored without a root attached to their original folder when folders change.
	let pinRootlessEntries = (): void => {
		let owner = roots.rootlessOwner();
		if (owner !== undefined) {
			store.pinRootless(owner);
		}
	};

	let updateChrome = (): void => {
		let active = store.active;
		// Shown as "File Worksets: <name>" when this is the only visible view in the container.
		activeView.title = active ? worksetLabel(active) : ACTIVE_VIEW_NAME;
		void vscode.commands.executeCommand('setContext', 'fileWorksets.hasActiveWorkset', active !== undefined);
		void vscode.commands.executeCommand('setContext', 'fileWorksets.hasWorksets', store.all.length > 0);
		// Selects which icon variant of the auto-add button is shown.
		void vscode.commands.executeCommand('setContext', 'fileWorksets.autoAdd', readAutoAddMode());
		let show = vscode.workspace.getConfiguration('fileWorksets').get<boolean>('showStatusBarItem', true);
		if (!show || !store.hasStorage) {
			statusBar.hide();
			return;
		}
		statusBar.text = `$(files) ${active ? worksetLabel(active) : 'No Workset'}`;
		statusBar.tooltip = active
			? `Active workset: ${worksetLabel(active)}. Click to switch or create a workset.`
			: 'No active workset. Click to switch or create a workset.';
		statusBar.show();
	};

	context.subscriptions.push(
		store.onDidChange(() => {
			refreshViews();
			updateChrome();
		}),
	);

	// File system changes only matter if they touch a referenced path or a folder entry. The lookup is
	// indexed because a branch switch can produce thousands of events.
	let refreshSoon = debounce(refreshViews, 250);
	context.subscriptions.push(refreshSoon);
	let touches: { defaultRoot: string | undefined; lookup: (root: string | undefined, path: string) => boolean } | undefined;
	context.subscriptions.push(store.onDidChange(() => (touches = undefined)));
	let onFsEvent = (uri: vscode.Uri): void => {
		let location = roots.locate(uri);
		if (!location) {
			return;
		}
		let defaultRoot = roots.defaultRoot();
		if (!touches || touches.defaultRoot !== defaultRoot) {
			touches = { defaultRoot, lookup: touchIndex(store.all.flatMap((w) => w.entries), defaultRoot) };
		}
		if (touches.lookup(location.root, location.path)) {
			refreshSoon();
		}
	};
	let watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
	context.subscriptions.push(
		watcher,
		// Restores from git or other tools show up only through the file watcher.
		watcher.onDidCreate((uri) => {
			deletions.restore(uri);
			onFsEvent(uri);
		}),
		watcher.onDidDelete(onFsEvent),
		vscode.workspace.onDidRenameFiles((event) => {
			for (let { oldUri, newUri } of event.files) {
				let from = roots.locate(oldUri);
				let to = roots.locate(newUri);
				if (from && to) {
					store.applyRename(from, to);
				}
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			await store.useBackend(createBackend(context, roots));
			pinRootlessEntries();
			refreshViews();
		}),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('fileWorksets.storageLocation')) {
				// Carried-over rootless entries belong to the current default folder, which the new
				// source may not share.
				let rootlessOwner = roots.isMultiRoot() ? roots.defaultRoot() : undefined;
				await store.useBackend(createBackend(context, roots), { rootlessOwner });
			}
			if (
				event.affectsConfiguration('fileWorksets.showStatusBarItem') ||
				event.affectsConfiguration('fileWorksets.autoAdd')
			) {
				updateChrome();
			}
			if (
				event.affectsConfiguration('fileWorksets.sortOrder') ||
				event.affectsConfiguration('files.exclude') ||
				event.affectsConfiguration('explorer.compactFolders') ||
				event.affectsConfiguration('explorer.sortOrder') ||
				event.affectsConfiguration('explorer.sortOrderLexicographicOptions')
			) {
				refreshViews();
			}
		}),
	);

	let worksetIdFrom = (arg: unknown): string | undefined => (isWorksetNode(arg) ? arg.id : undefined);
	// Menus pass (item, selectedItems); keybindings pass the focused view's ID (see package.json).
	let nodesFor = (primary: unknown, selection: unknown): FileNode[] => {
		if (primary === ACTIVE_VIEW_ID) {
			return activeView.selection.filter(isFileNode);
		}
		if (primary === LIST_VIEW_ID) {
			return listView.selection.filter(isFileNode);
		}
		return asFileNodes(primary, selection);
	};
	let register = (id: string, handler: (...args: unknown[]) => unknown): void => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('fileWorksets.createWorkset', (name?: unknown) =>
		actions.createWorkset(typeof name === 'string' ? name : undefined),
	);
	register('fileWorksets.switchWorkset', () => actions.switchWorkset());
	register('fileWorksets.deactivateWorkset', () => store.setActive(undefined));
	register('fileWorksets.activateWorkset', (arg?: unknown) => {
		let id = worksetIdFrom(arg) ?? (typeof arg === 'string' ? arg : undefined);
		if (id) {
			store.setActive(id);
		} else {
			return actions.switchWorkset();
		}
		return undefined;
	});
	register('fileWorksets.renameWorkset', (arg?: unknown) => actions.renameWorkset(worksetIdFrom(arg)));
	register('fileWorksets.duplicateWorkset', (arg?: unknown) => actions.duplicateWorkset(worksetIdFrom(arg)));
	register('fileWorksets.deleteWorkset', async (primary?: unknown, selection?: unknown) => {
		// From the context menu with several worksets selected, delete them all.
		let selected = Array.isArray(selection) ? selection.filter(isWorksetNode).map((n) => n.id) : [];
		let id = worksetIdFrom(primary);
		if (id && selected.includes(id) && selected.length > 1) {
			actions.deleteWorksets(selected);
		} else {
			await actions.deleteWorkset(id);
		}
	});
	register('fileWorksets.deleteActiveWorkset', () => {
		let active = store.active;
		if (active) {
			actions.deleteWorksets([active.id]);
		}
	});
	register('fileWorksets.sortWorksets', async () => {
		let config = vscode.workspace.getConfiguration('fileWorksets');
		let current = config.get<SortOrder>('sortOrder', 'created');
		let options: { label: string; value: SortOrder }[] = [
			{ label: 'Last Used', value: 'lastUsed' },
			{ label: 'Created', value: 'created' },
			{ label: 'Name', value: 'name' },
		];
		let picked = await vscode.window.showQuickPick(
			options.map((o) => ({ ...o, description: o.value === current ? 'current' : undefined })),
			{ placeHolder: 'Sort worksets by' },
		);
		if (picked) {
			await updateSetting('sortOrder', picked.value);
		}
	});
	register('fileWorksets.refresh', refreshViews);

	// The three button variants (one icon per mode) and the palette command all open the same picker.
	// Programmatic callers can pass a mode directly.
	let setAutoAdd = async (arg?: unknown): Promise<void> => {
		let current = readAutoAddMode();
		let mode: AutoAddMode | undefined = isAutoAddMode(arg) ? arg : undefined;
		if (!mode) {
			let picked = await vscode.window.showQuickPick(
				AUTO_ADD_MODES.map((m) => ({
					label: m.label,
					description: m.mode === current ? 'current' : undefined,
					detail: m.detail,
					mode: m.mode,
				})),
				{ title: 'Auto-Add Files to the Active Workset' },
			);
			mode = picked?.mode;
		}
		if (!mode || mode === current) {
			return;
		}
		await updateSetting('autoAdd', mode);
	};
	register('fileWorksets.setAutoAdd', setAutoAdd);
	register('fileWorksets.autoAdd.off', () => setAutoAdd());
	register('fileWorksets.autoAdd.opened', () => setAutoAdd());
	register('fileWorksets.autoAdd.edited', () => setAutoAdd());

	register('fileWorksets.addToActiveWorkset', (primary?: unknown, selection?: unknown) =>
		actions.addUris(urisFromArgs(primary, selection)),
	);
	register('fileWorksets.addToWorkset', async (primary?: unknown, selection?: unknown) => {
		if (!actions.requireWorkspace()) {
			return;
		}
		let uris = urisFromArgs(primary, selection);
		let workset = await actions.pickWorkset({ placeHolder: 'Add to workset', allowCreate: true });
		if (workset) {
			await actions.addUris(uris, workset);
		}
	});
	register('fileWorksets.addActiveEditor', () => actions.addUris(urisFromArgs(undefined, undefined)));
	register('fileWorksets.addOpenEditors', () => {
		let uris = new Map<string, vscode.Uri>();
		for (let group of vscode.window.tabGroups.all) {
			for (let tab of group.tabs) {
				let uri = tabUri(tab);
				if (uri) {
					uris.set(uri.toString(), uri);
				}
			}
		}
		return actions.addUris([...uris.values()]);
	});
	register('fileWorksets.removeActiveEditor', async () => {
		let workset = store.active;
		let uris = urisFromArgs(undefined, undefined);
		if (workset && uris.length) {
			await actions.removeUris(uris, workset);
		}
	});
	register('fileWorksets.removeFromWorkset', async (primary?: unknown, selection?: unknown) => {
		// The Delete key in the File Worksets list deletes selected worksets; file items are removed from their workset.
		if (primary === LIST_VIEW_ID) {
			let worksetIds = listView.selection.filter(isWorksetNode).map((n) => n.id);
			let hasFiles = listView.selection.some(isFileNode);
			if (worksetIds.length && hasFiles) {
				void vscode.window.showInformationMessage(
					'File Worksets: Select either worksets (to delete them) or files (to remove them), not both.',
				);
				return;
			}
			if (worksetIds.length) {
				actions.deleteWorksets(worksetIds);
				return;
			}
		}
		await actions.removeNodes(nodesFor(primary, selection));
	});
	register('fileWorksets.removeMissing', async (arg?: unknown) => {
		let id = worksetIdFrom(arg);
		let workset = id ? store.get(id) : store.active;
		if (workset) {
			await actions.removeMissing(workset);
		}
	});
	register('fileWorksets.copyToWorkset', (primary?: unknown, selection?: unknown) =>
		actions.copyOrMove(nodesFor(primary, selection), false),
	);
	register('fileWorksets.moveToWorkset', (primary?: unknown, selection?: unknown) =>
		actions.copyOrMove(nodesFor(primary, selection), true),
	);

	// Explorer-style item commands. Built-in commands are called with the item's URI, as the Explorer does.
	let existingFiles = (primary: unknown, selection: unknown): FileNode[] =>
		nodesFor(primary, selection).filter((n) => !n.isDirectory && !n.missing);
	let existing = (primary: unknown, selection: unknown): FileNode[] =>
		nodesFor(primary, selection).filter((n) => !n.missing);
	let forEachUri = async (uris: readonly vscode.Uri[], command: string): Promise<void> => {
		for (let uri of new Map(uris.map((u) => [u.toString(), u])).values()) {
			await vscode.commands.executeCommand(command, uri);
		}
	};

	register('fileWorksets.newFile', (primary?: unknown) => {
		let [node] = nodesFor(primary, undefined);
		return node ? actions.createIn(node, 'file') : undefined;
	});
	register('fileWorksets.newFolder', (primary?: unknown) => {
		let [node] = nodesFor(primary, undefined);
		return node ? actions.createIn(node, 'folder') : undefined;
	});
	register('fileWorksets.openToSide', async (primary?: unknown, selection?: unknown) => {
		for (let node of existingFiles(primary, selection)) {
			await vscode.commands.executeCommand('vscode.open', node.uri, {
				viewColumn: vscode.ViewColumn.Beside,
				preview: false,
			});
		}
	});
	register('fileWorksets.openWith', (primary?: unknown) => {
		let [node] = existingFiles(primary, undefined);
		return node ? vscode.commands.executeCommand('explorer.openWith', node.uri) : undefined;
	});
	let revealInOS = (primary?: unknown, selection?: unknown): Promise<void> =>
		forEachUri(existing(primary, selection).map((n) => n.uri), 'revealFileInOS');
	register('fileWorksets.revealFileInOS.windows', revealInOS);
	register('fileWorksets.revealFileInOS.mac', revealInOS);
	register('fileWorksets.revealFileInOS.linux', revealInOS);
	register('fileWorksets.openInIntegratedTerminal', (primary?: unknown, selection?: unknown) =>
		forEachUri(
			existing(primary, selection).map((n) => (n.isDirectory ? n.uri : vscode.Uri.joinPath(n.uri, '..'))),
			'openInIntegratedTerminal',
		),
	);
	register('fileWorksets.revealInExplorer', (primary?: unknown) => {
		let [node] = existing(primary, undefined);
		return node ? vscode.commands.executeCommand('revealInExplorer', node.uri) : undefined;
	});
	register('fileWorksets.selectForCompare', (primary?: unknown) => {
		let [node] = existingFiles(primary, undefined);
		return node ? vscode.commands.executeCommand('selectForCompare', node.uri) : undefined;
	});
	register('fileWorksets.compareWithSelected', (primary?: unknown) => {
		let [node] = existingFiles(primary, undefined);
		return node ? vscode.commands.executeCommand('compareFiles', node.uri) : undefined;
	});
	register('fileWorksets.compareSelected', (primary?: unknown, selection?: unknown) => {
		let [left, right] = existingFiles(primary, selection);
		return left && right
			? vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${left.label} ↔ ${right.label}`)
			: undefined;
	});
	register('fileWorksets.findInFolder', (primary?: unknown) => {
		let [node] = existing(primary, undefined).filter((n) => n.isDirectory);
		return node ? vscode.commands.executeCommand('filesExplorer.findInFolder', node.uri) : undefined;
	});
	register('fileWorksets.copyPath', (primary?: unknown, selection?: unknown) =>
		vscode.env.clipboard.writeText(
			nodesFor(primary, selection)
				.map((n) => (n.uri.scheme === 'file' ? n.uri.fsPath : n.uri.toString()))
				.join('\n'),
		),
	);
	register('fileWorksets.copyRelativePath', (primary?: unknown, selection?: unknown) =>
		vscode.env.clipboard.writeText(
			nodesFor(primary, selection)
				.map((n) => roots.displayPath(n.root, n.path))
				.join('\n'),
		),
	);
	register('fileWorksets.renameFile', (primary?: unknown) => {
		// From a keybinding there's no clicked item, and the API doesn't expose the focused row,
		// so rename only works on a single selected item.
		let fromKey = primary === ACTIVE_VIEW_ID || primary === LIST_VIEW_ID;
		let selection: readonly (TreeNode | ActiveNode)[] = primary === LIST_VIEW_ID ? listView.selection : activeView.selection;
		if (fromKey && selection.length !== 1) {
			if (selection.length > 1) {
				void vscode.window.showInformationMessage('File Worksets: Select a single item to rename.');
			}
			return undefined;
		}
		// The rename key on a workset row in the File Worksets list renames the workset.
		let [focused] = primary === LIST_VIEW_ID ? selection : [];
		if (isWorksetNode(focused)) {
			return actions.renameWorkset(focused.id);
		}
		let [node] = existing(primary, undefined);
		return node ? actions.renameOnDisk(node) : undefined;
	});
	register('fileWorksets.deleteFile', (primary?: unknown, selection?: unknown) =>
		actions.deleteOnDisk(nodesFor(primary, selection)),
	);

	await store.useBackend(createBackend(context, roots));
	pinRootlessEntries();
	updateChrome();
	void deletions.reconcile();

	return { store, actions, activeFiles, worksets, activeView, listView, revealer, decorations };
}

export function deactivate(): void {}
