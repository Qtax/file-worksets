import * as vscode from 'vscode';
import {
	coveringFolder,
	formatRelativeTime,
	makeEntry,
	removeUnder,
	sameRoot,
	sortWorksets,
	validateWorksetName,
	worksetLabel,
	type EntryKind,
	type SortOrder,
	type Workset,
	type WorksetEntry,
} from './core/model.ts';
import { baseName, isSameOrUnder, sanitizeRelativePath } from './core/paths.ts';
import { isFileNode, isWorksetNode, type FileNode, type TreeNode } from './fileTree.ts';
import { joinPath, type WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Worksets in the order chosen with `fileWorksets.sortOrder`, used by the list and all pickers. */
export function sortedWorksets(store: WorksetStore): Workset[] {
	let order = vscode.workspace.getConfiguration('fileWorksets').get<SortOrder>('sortOrder', 'created');
	return sortWorksets(store.all, order, store.lastUsedTimes);
}

export function describeWorkset(workset: Workset): string {
	let files = workset.entries.filter((e) => e.kind === 'file').length;
	let folders = workset.entries.length - files;
	let parts = [plural(files, 'file')];
	if (folders) {
		parts.push(plural(folders, 'folder'));
	}
	return parts.join(', ');
}

export function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
	let input = tab?.input;
	if (
		input instanceof vscode.TabInputText ||
		input instanceof vscode.TabInputCustom ||
		input instanceof vscode.TabInputNotebook
	) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return input.modified;
	}
	return undefined;
}

export class WorksetActions {
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;

	constructor(store: WorksetStore, roots: WorkspaceRoots) {
		this.store = store;
		this.roots = roots;
	}

	requireWorkspace(): boolean {
		if (this.store.hasStorage) {
			return true;
		}
		void vscode.window.showInformationMessage('File Worksets: Open a folder or workspace first.');
		return false;
	}

	promptName(title: string, value?: string, exceptId?: string): Thenable<string | undefined> {
		return vscode.window.showInputBox({
			title,
			prompt: 'Workset name. Leave empty to show the creation time instead.',
			value,
			validateInput: (input) => validateWorksetName(input, this.store.all, exceptId),
		});
	}

	/** Creates and activates a workset. Without a name it's unnamed and shown by its creation time. */
	async createWorkset(name = '', entries: readonly WorksetEntry[] = []): Promise<Workset | undefined> {
		if (!this.requireWorkspace()) {
			return undefined;
		}
		let error = validateWorksetName(name, this.store.all);
		if (error) {
			void vscode.window.showErrorMessage(error);
			return undefined;
		}
		let workset = this.store.create(name, entries);
		vscode.window.setStatusBarMessage(`$(add) Created workset "${worksetLabel(workset)}". Press F2 in the list to rename it.`, 4000);
		return workset;
	}

	/** The active workset; if none is active, a new one is created and activated. */
	async ensureActive(): Promise<Workset | undefined> {
		if (!this.requireWorkspace()) {
			return undefined;
		}
		return this.store.active ?? this.createWorkset();
	}

	async pickWorkset(options: { placeHolder: string; excludeId?: string; allowCreate?: boolean }): Promise<Workset | undefined> {
		type Item = vscode.QuickPickItem & { workset?: Workset; create?: boolean };
		let activeId = this.store.active?.id;
		let items: Item[] = sortedWorksets(this.store)
			.filter((w) => w.id !== options.excludeId)
			.map((w) => ({
				label: worksetLabel(w),
				iconPath: new vscode.ThemeIcon(w.id === activeId ? 'check' : 'blank'),
				description: describeWorkset(w),
				workset: w,
			}));
		if (options.allowCreate) {
			items.unshift({ label: 'New Workset', iconPath: new vscode.ThemeIcon('add'), create: true, alwaysShow: true });
		}
		let picked = await vscode.window.showQuickPick(items, { placeHolder: options.placeHolder });
		if (picked?.create) {
			return this.createWorkset();
		}
		return picked?.workset;
	}

	async switchWorkset(): Promise<void> {
		if (!this.requireWorkspace()) {
			return;
		}
		type Item = vscode.QuickPickItem & { workset?: Workset; create?: boolean; deactivate?: boolean };
		let renameButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Rename' };
		let deleteButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' };
		let quickPick = vscode.window.createQuickPick<Item>();
		quickPick.placeholder = 'Switch to a workset, or create a new one';
		quickPick.matchOnDescription = true;

		let build = (): void => {
			let activeId = this.store.active?.id;
			let sorted = sortedWorksets(this.store);
			let items: Item[] = [
				{ label: 'New Workset', iconPath: new vscode.ThemeIcon('add'), create: true, alwaysShow: true },
				{
					label: 'No Active Workset',
					iconPath: new vscode.ThemeIcon('circle-slash'),
					description: activeId ? 'Work without a workset; nothing is added automatically' : 'current',
					deactivate: true,
					alwaysShow: true,
				},
				{ label: '', kind: vscode.QuickPickItemKind.Separator },
				...sorted.map((w) => ({
					label: worksetLabel(w),
					iconPath: new vscode.ThemeIcon(w.id === activeId ? 'check' : 'blank'),
					description: `${w.id === activeId ? 'active · ' : ''}${describeWorkset(w)}`,
					detail: `Last used ${formatRelativeTime(this.store.lastUsedTimes[w.id])}`,
					buttons: [renameButton, deleteButton],
					workset: w,
				})),
			];
			quickPick.items = items;
			// Highlight where you are: the active workset, or "No Active Workset" when none is active.
			let current = items.find((item) => (activeId ? item.workset?.id === activeId : item.deactivate));
			if (current) {
				quickPick.activeItems = [current];
			}
		};
		build();

		// Rename/delete open their own quick input, which hides this one; keep it alive and reshow it afterwards.
		let nestedInput = false;
		quickPick.onDidTriggerItemButton(async ({ button, item }) => {
			if (!item.workset) {
				return;
			}
			nestedInput = true;
			try {
				if (button === renameButton) {
					await this.renameWorkset(item.workset.id);
				} else if (button === deleteButton) {
					await this.deleteWorkset(item.workset.id);
				}
			} finally {
				nestedInput = false;
			}
			build();
			quickPick.show();
		});
		quickPick.onDidAccept(async () => {
			let [selected] = quickPick.selectedItems;
			quickPick.hide();
			if (selected?.create) {
				await this.createWorkset();
			} else if (selected?.deactivate) {
				this.store.setActive(undefined);
			} else if (selected?.workset) {
				this.store.setActive(selected.workset.id);
			}
		});
		quickPick.onDidHide(() => {
			if (!nestedInput) {
				quickPick.dispose();
			}
		});
		quickPick.show();
	}

	async renameWorkset(id: string | undefined): Promise<void> {
		let workset = id ? this.store.get(id) : this.store.active;
		if (!workset) {
			return;
		}
		let name = await this.promptName('Rename Workset', workset.name, workset.id);
		if (name !== undefined) {
			this.store.rename(workset.id, name);
		}
	}

	async duplicateWorkset(id: string | undefined): Promise<void> {
		let workset = id ? this.store.get(id) : this.store.active;
		if (!workset) {
			return;
		}
		// Copies of unnamed worksets stay unnamed (shown by their own creation time).
		let suggestion = '';
		if (workset.name) {
			suggestion = `${workset.name} (copy)`;
			for (let n = 2; validateWorksetName(suggestion, this.store.all); n++) {
				suggestion = `${workset.name} (copy ${n})`;
			}
		}
		let name = await this.promptName('Duplicate Workset', suggestion);
		if (name !== undefined) {
			this.store.create(name, workset.entries);
		}
	}

	async deleteWorkset(id: string | undefined): Promise<void> {
		if (id) {
			this.deleteWorksets([id]);
			return;
		}
		// From the Command Palette: pick any number of worksets.
		let activeId = this.store.active?.id;
		let picked = await vscode.window.showQuickPick(
			sortedWorksets(this.store).map((w) => ({
				label: worksetLabel(w),
				description: `${w.id === activeId ? 'active · ' : ''}${describeWorkset(w)}`,
				id: w.id,
			})),
			{ placeHolder: 'Select the worksets to delete', canPickMany: true },
		);
		if (picked?.length) {
			this.deleteWorksets(picked.map((item) => item.id));
		}
	}

	/**
	 * Deletes worksets right away and offers Undo in a notification. Files on disk are never touched.
	 * Returns the undo function, or undefined if nothing was deleted.
	 */
	deleteWorksets(ids: readonly string[]): (() => void) | undefined {
		let worksets = [...new Set(ids)].map((id) => this.store.get(id)).filter((w) => w !== undefined);
		let [first] = worksets;
		if (!first) {
			return undefined;
		}
		let lastUsed = { ...this.store.lastUsedTimes };
		let activeId = this.store.active?.id;
		for (let workset of worksets) {
			this.store.delete(workset.id);
		}
		let undo = (): void => this.store.restore(worksets, lastUsed, activeId);
		let message =
			worksets.length === 1 ? `Deleted workset "${worksetLabel(first)}".` : `Deleted ${worksets.length} worksets.`;
		void vscode.window.showInformationMessage(message, 'Undo').then((choice) => {
			if (choice === 'Undo') {
				undo();
			}
		});
		return undo;
	}

	/** Converts URIs (Explorer selection, editors, drops) into entries. */
	async entriesFromUris(uris: readonly vscode.Uri[]): Promise<{ entries: WorksetEntry[]; skipped: number }> {
		let entries: WorksetEntry[] = [];
		let skipped = 0;
		for (let uri of uris) {
			let location = this.roots.locate(uri);
			if (!location) {
				skipped++;
				continue;
			}
			let kind: WorksetEntry['kind'] = 'file';
			try {
				let stat = await vscode.workspace.fs.stat(uri);
				kind = (stat.type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file';
			} catch {
				skipped++;
				continue;
			}
			entries.push(makeEntry(kind, location.path, location.root));
		}
		return { entries, skipped };
	}

	async addUris(uris: readonly vscode.Uri[], target?: Workset): Promise<WorksetEntry[]> {
		if (uris.length === 0) {
			void vscode.window.showInformationMessage('File Worksets: Nothing to add. Select a file in the Explorer or open an editor.');
			return [];
		}
		let workset = target ?? (await this.ensureActive());
		if (!workset) {
			return [];
		}
		let { entries, skipped } = await this.entriesFromUris(uris);
		let added = this.store.addEntries(workset.id, entries);
		this.reportAdded(workset, added.length, entries.length - added.length, skipped);
		return added;
	}

	/** Entries represented by dragged or selected tree nodes. */
	entriesFromNodes(nodes: readonly TreeNode[]): WorksetEntry[] {
		let defaultRoot = this.roots.defaultRoot();
		let entries: WorksetEntry[] = [];
		for (let node of nodes) {
			if (isWorksetNode(node)) {
				entries.push(...(this.store.get(node.id)?.entries ?? []));
				continue;
			}
			let entry = (kind: WorksetEntry['kind']): WorksetEntry => makeEntry(kind, node.path, node.root);
			switch (node.origin) {
				case 'file':
				case 'dynamicFile':
					entries.push(entry('file'));
					break;
				case 'folder':
				case 'dynamicFolder':
					entries.push(entry('folder'));
					break;
				case 'implicit':
				case 'root': {
					let source = this.store.get(node.worksetId)?.entries ?? [];
					entries.push(...source.filter((e) => removeUnder([e], node.root, node.path, defaultRoot).removed.length));
					break;
				}
			}
		}
		return entries;
	}

	async addNodes(nodes: readonly TreeNode[], target: Workset): Promise<void> {
		let sources = nodes.filter((n) => (isWorksetNode(n) ? n.id : n.worksetId) !== target.id);
		if (sources.length) {
			this.addEntriesTo(target, this.entriesFromNodes(sources));
		}
	}

	addEntriesTo(target: Workset, entries: readonly WorksetEntry[]): WorksetEntry[] {
		let added = this.store.addEntries(target.id, entries);
		this.reportAdded(target, added.length, entries.length - added.length, 0);
		return added;
	}

	async copyOrMove(nodes: readonly FileNode[], move: boolean): Promise<void> {
		if (nodes.length === 0) {
			return;
		}
		let sourceIds = new Set(nodes.map((n) => n.worksetId));
		let target = await this.pickWorkset({
			placeHolder: move ? 'Move to workset' : 'Copy to workset',
			excludeId: sourceIds.size === 1 ? [...sourceIds][0] : undefined,
			allowCreate: true,
		});
		if (!target) {
			return;
		}
		await this.addNodes(nodes, target);
		if (move) {
			await this.removeNodes(nodes.filter((n) => n.worksetId !== target.id));
		}
	}

	/** Removes references without asking; never touches files on disk. */
	async removeNodes(nodes: readonly FileNode[]): Promise<void> {
		let defaultRoot = this.roots.defaultRoot();
		let byWorkset = new Map<string, FileNode[]>();
		let included: FileNode[] = [];
		for (let node of nodes) {
			if (node.origin === 'dynamicFile' || node.origin === 'dynamicFolder') {
				included.push(node);
				continue;
			}
			byWorkset.set(node.worksetId, [...(byWorkset.get(node.worksetId) ?? []), node]);
		}

		for (let [worksetId, targets] of byWorkset) {
			let workset = this.store.get(worksetId);
			if (!workset) {
				continue;
			}
			let entries = [...workset.entries];
			for (let node of targets) {
				if (node.origin === 'implicit' || node.origin === 'root') {
					entries = removeUnder(entries, node.root, node.path, defaultRoot).entries;
				} else {
					entries = entries.filter((e) => !(sameRoot(e.root, node.root, defaultRoot) && e.path === node.path));
				}
			}
			if (entries.length !== workset.entries.length) {
				this.store.setEntries(worksetId, entries);
			}
		}

		let [first] = included;
		if (first) {
			let workset = this.store.get(first.worksetId);
			let cover = workset && coveringFolder(workset.entries, first.root, first.path, defaultRoot);
			void vscode.window.showInformationMessage(
				cover
					? `"${first.path}" is included through the folder "${cover.path}". Remove that folder from the workset instead.`
					: `"${first.path}" is included through a folder entry.`,
			);
		}
	}

	async removeUris(uris: readonly vscode.Uri[], workset: Workset): Promise<number> {
		let defaultRoot = this.roots.defaultRoot();
		let locations = uris.map((uri) => this.roots.locate(uri)).filter((l) => l !== undefined);
		let entries = workset.entries.filter(
			(e) => !locations.some((l) => sameRoot(e.root, l.root, defaultRoot) && e.path === l.path),
		);
		let removed = workset.entries.length - entries.length;
		if (removed) {
			this.store.setEntries(workset.id, entries);
		} else if (uris.length) {
			let cover = locations[0] && coveringFolder(workset.entries, locations[0].root, locations[0].path, defaultRoot);
			void vscode.window.showInformationMessage(
				cover
					? `This file is included through the folder "${cover.path}". Remove that folder instead.`
					: `This file is not in workset "${worksetLabel(workset)}".`,
			);
		}
		return removed;
	}

	async removeMissing(workset: Workset): Promise<number> {
		let kept: WorksetEntry[] = [];
		for (let entry of workset.entries) {
			let uri = this.roots.uriFor(entry.root, entry.path);
			if (!uri) {
				kept.push(entry);
				continue;
			}
			try {
				await vscode.workspace.fs.stat(uri);
				kept.push(entry);
			} catch {
				// missing: drop it
			}
		}
		let removed = workset.entries.length - kept.length;
		if (removed) {
			this.store.setEntries(workset.id, kept);
		}
		void vscode.window.showInformationMessage(
			removed
				? `Removed ${plural(removed, 'missing reference')} from "${worksetLabel(workset)}".`
				: `No missing files in "${worksetLabel(workset)}".`,
		);
		return removed;
	}

	/** Validates a new file or folder name relative to `parent`; `a/b.ts` creates nested folders. */
	async validateNewName(parent: vscode.Uri, value: string, singleSegment = false): Promise<string | undefined> {
		let name = value.trim();
		if (!name) {
			return 'A file or folder name must be provided.';
		}
		let relative = sanitizeRelativePath(name);
		if (!relative || (singleSegment && relative.includes('/'))) {
			return `The name **${name}** is not valid as a file or folder name. Please choose a different name.`;
		}
		if (process.platform === 'win32' && /[<>:"|?*\u0000-\u001f]/.test(relative)) {
			return `The name **${name}** is not valid as a file or folder name. Please choose a different name.`;
		}
		try {
			await vscode.workspace.fs.stat(joinPath(parent, relative));
			return `A file or folder **${name}** already exists at this location. Please choose a different name.`;
		} catch {
			return undefined;
		}
	}

	/** Creates a file or folder inside a folder node and adds it to that node's workset. */
	async createIn(parent: FileNode, kind: EntryKind, name?: string): Promise<vscode.Uri | undefined> {
		if (!parent.isDirectory || parent.missing) {
			return undefined;
		}
		let where = this.roots.displayPath(parent.root, parent.path) || 'the workspace folder';
		let input =
			name ??
			(await vscode.window.showInputBox({
				title: kind === 'file' ? 'New File' : 'New Folder',
				prompt: `Create a ${kind} in ${where}. Use "/" to create subfolders.`,
				validateInput: (value) => this.validateNewName(parent.uri, value),
			}));
		if (input === undefined) {
			return undefined;
		}
		let error = await this.validateNewName(parent.uri, input);
		let relative = sanitizeRelativePath(input.trim());
		if (error || !relative) {
			void vscode.window.showErrorMessage(error ?? 'Invalid name.');
			return undefined;
		}
		let target = joinPath(parent.uri, relative);
		if (kind === 'file') {
			let edit = new vscode.WorkspaceEdit();
			edit.createFile(target, { overwrite: false, ignoreIfExists: false });
			if (!(await vscode.workspace.applyEdit(edit))) {
				void vscode.window.showErrorMessage(`Could not create "${input.trim()}".`);
				return undefined;
			}
		} else {
			await vscode.workspace.fs.createDirectory(target);
		}
		let location = this.roots.locate(target);
		if (location && this.store.get(parent.worksetId)) {
			this.store.addEntries(parent.worksetId, [makeEntry(kind, location.path, location.root)]);
		}
		if (kind === 'file') {
			await vscode.commands.executeCommand('vscode.open', target, { preview: false });
		}
		return target;
	}

	/** Renames a file or folder on disk. References in all worksets follow via `onDidRenameFiles`. */
	async renameOnDisk(node: FileNode, newName?: string): Promise<boolean> {
		if (node.missing || node.origin === 'root') {
			return false;
		}
		let current = baseName(node.path);
		let parentUri = vscode.Uri.joinPath(node.uri, '..');
		// Case-only renames look like a conflict on case-insensitive file systems, so allow them.
		let validate = (value: string): Promise<string | undefined> | undefined =>
			value.trim().toLowerCase() === current.toLowerCase() ? undefined : this.validateNewName(parentUri, value, true);
		let dot = current.lastIndexOf('.');
		let input =
			newName ??
			(await vscode.window.showInputBox({
				title: 'Rename',
				value: current,
				valueSelection: [0, !node.isDirectory && dot > 0 ? dot : current.length],
				validateInput: validate,
			}));
		let name = input?.trim();
		if (!name || name === current) {
			return false;
		}
		let error = await validate(name);
		if (error) {
			void vscode.window.showErrorMessage(error);
			return false;
		}
		let edit = new vscode.WorkspaceEdit();
		edit.renameFile(node.uri, joinPath(parentUri, name), { overwrite: false });
		let ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			void vscode.window.showErrorMessage(`Could not rename "${current}".`);
		}
		return ok;
	}

	/**
	 * Deletes files or folders from disk (to the trash if `files.enableTrash` is on) and drops
	 * their references from the workset they were deleted from. Other worksets keep them as missing.
	 */
	async deleteOnDisk(nodes: readonly FileNode[], confirm = true): Promise<number> {
		let defaultRoot = this.roots.defaultRoot();
		let candidates = nodes.filter((n) => !n.missing && n.origin !== 'root');
		// Deleting a folder deletes its contents, so skip selected items inside other selected items.
		let targets = candidates.filter(
			(n) =>
				!candidates.some(
					(other) =>
						other.path !== n.path && sameRoot(other.root, n.root, defaultRoot) && isSameOrUnder(n.path, other.path),
				),
		);
		let unique = [...new Map(targets.map((n) => [n.uri.toString(), n])).values()];
		let [first] = unique;
		if (!first) {
			return 0;
		}
		if (confirm) {
			let useTrash = vscode.workspace.getConfiguration('files').get<boolean>('enableTrash', true);
			let bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
			let message =
				unique.length === 1
					? `Are you sure you want to delete '${baseName(first.path)}'${first.isDirectory ? ' and its contents' : ''}?`
					: `Are you sure you want to delete the following ${unique.length} files/folders and their contents?`;
			let names = unique.slice(0, 10).map((n) => baseName(n.path));
			let list = unique.length === 1 ? '' : `${names.join('\n')}${unique.length > 10 ? '\n...' : ''}\n\n`;
			let restore = useTrash
				? `You can restore ${unique.length === 1 ? 'it' : 'them'} from the ${bin}.`
				: 'This action is irreversible!';
			let button = useTrash ? `Move to ${bin}` : 'Delete';
			let answer = await vscode.window.showWarningMessage(message, { modal: true, detail: `${list}${restore}` }, button);
			if (answer !== button) {
				return 0;
			}
		}
		let edit = new vscode.WorkspaceEdit();
		for (let node of unique) {
			edit.deleteFile(node.uri, { recursive: true, ignoreIfNotExists: true });
		}
		// References are removed from all worksets by DeletionTracker (onDidDeleteFiles).
		if (!(await vscode.workspace.applyEdit(edit))) {
			void vscode.window.showErrorMessage('Could not delete the selected items.');
			return 0;
		}
		return unique.length;
	}

	/** Feedback for drops that change nothing, since VS Code can't show "not allowed" while dragging. */
	reportAlreadyIn(workset: Workset | undefined): void {
		if (workset) {
			vscode.window.setStatusBarMessage(`$(info) Already in "${worksetLabel(workset)}". Nothing changed.`, 3000);
		}
	}

	private reportAdded(workset: Workset, added: number, existing: number, skipped: number): void {
		if (skipped) {
			void vscode.window.showWarningMessage(
				`File Worksets: Skipped ${plural(skipped, 'item')} outside the workspace folders or not found on disk.`,
			);
		}
		if (!added) {
			if (existing) {
				this.reportAlreadyIn(workset);
			}
			return;
		}
		let message = `$(check) Added ${plural(added, 'item')} to "${worksetLabel(workset)}".`;
		if (existing) {
			message += ` ${plural(existing, 'item')} already in the workset.`;
		}
		vscode.window.setStatusBarMessage(message, 4000);
	}
}

export function asFileNodes(primary: unknown, selection: unknown): FileNode[] {
	let list = Array.isArray(selection) && selection.length ? selection : [primary];
	return list.filter(isFileNode);
}
