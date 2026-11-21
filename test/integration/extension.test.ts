import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { FileWorksetsApi } from '../../src/extension.ts';
import type { FileNode } from '../../src/fileTree.ts';

suite('File Worksets', () => {
	let api: FileWorksetsApi;
	let root: vscode.Uri;

	let uri = (path: string): vscode.Uri => vscode.Uri.joinPath(root, ...path.split('/'));
	let children = async (parent?: FileNode): Promise<FileNode[]> => api.activeFiles.getChildren(parent);
	let labels = async (parent?: FileNode): Promise<string[]> => (await children(parent)).map((n) => n.label);
	let child = async (parent: FileNode | undefined, label: string): Promise<FileNode> => {
		let node = (await children(parent)).find((n) => n.label === label);
		assert.ok(node, `expected tree item "${label}"`);
		return node;
	};
	let activePaths = (): string[] => (api.store.active?.entries ?? []).map((e) => `${e.kind}:${e.path}`);
	let exists = async (target: vscode.Uri): Promise<boolean> =>
		vscode.workspace.fs.stat(target).then(
			() => true,
			() => false,
		);
	let tabCount = (): number => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
	// Generous limit: file events can arrive late when VS Code is busy. Most waits finish within milliseconds.
	let waitFor = async (condition: () => boolean, what: string): Promise<void> => {
		for (let i = 0; i < 200 && !condition(); i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(condition(), `timed out waiting for ${what}`);
	};

	suiteSetup(async () => {
		let extension = vscode.extensions.getExtension<FileWorksetsApi>('local.file-worksets');
		assert.ok(extension);
		api = await extension.activate();
		let folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder);
		root = folder.uri;
	});

	test('creates a workset and adds a multi-selection from the Explorer; re-adding is a no-op', async () => {
		await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Task A');
		assert.equal(api.store.active?.name, 'Task A');

		await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/lib/b.ts'), [
			uri('src/lib/b.ts'),
			uri('test/a.test.ts'),
		]);
		assert.deepEqual(activePaths(), ['file:src/lib/b.ts', 'file:test/a.test.ts']);

		await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/lib/b.ts'));
		assert.equal(api.store.active?.entries.length, 2);
	});

	test('view title shows the active workset name', () => {
		assert.equal(api.activeView.title, 'Task A');
	});

	test('tree shows only folders that lead to selected files', async () => {
		assert.deepEqual(await labels(), ['src/lib', 'test']);
		let lib = await child(undefined, 'src/lib');
		let separator = process.platform === 'win32' ? '\\' : '/';
		assert.equal(api.activeFiles.getTreeItem(lib).label, `src\u2009${separator}\u2009lib`, 'compact folders use the OS separator');
		assert.deepEqual(await labels(lib), ['b.ts'], 'sibling c.ts must not be shown');
		let item = api.activeFiles.getTreeItem(await child(lib, 'b.ts'));
		assert.equal(item.command?.command, 'vscode.open');
		assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
	});

	test('folder entries show current disk contents and pick up new files', async () => {
		await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('docs'));
		assert.ok(activePaths().includes('folder:docs'));
		let docs = await child(undefined, 'docs');
		assert.equal(docs.origin, 'folder');
		assert.deepEqual(await labels(docs), ['readme.md']);

		await vscode.workspace.fs.writeFile(uri('docs/new.md'), new TextEncoder().encode('# new'));
		assert.deepEqual(await labels(docs), ['new.md', 'readme.md']);

		// Single-subfolder chains on disk are compacted like in the Explorer.
		await vscode.workspace.fs.writeFile(uri('docs/guides/setup/intro.md'), new TextEncoder().encode('# intro'));
		assert.deepEqual(await labels(docs), ['guides/setup', 'new.md', 'readme.md']);
		assert.deepEqual(await labels(await child(docs, 'guides/setup')), ['intro.md']);
		await vscode.workspace.fs.delete(uri('docs/guides'), { recursive: true });

		await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('docs/new.md'));
		assert.equal(activePaths().filter((p) => p.includes('new.md')).length, 0, 'already covered by folder');
	});

	test('stores in workspace storage by default; switching to the repo file copies worksets there', async () => {
		await api.store.flush();
		let file = uri('.vscode/file-worksets.json');
		assert.ok(!(await exists(file)), 'nothing is written to the repo by default');

		await vscode.workspace
			.getConfiguration('fileWorksets')
			.update('storageLocation', 'workspaceFolder', vscode.ConfigurationTarget.Workspace);
		await waitFor(() => api.store.all.length > 0, 'worksets to be loaded from the new location');
		await api.store.flush();
		let data = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
		assert.equal(data.worksets[0].name, 'Task A');
		assert.deepEqual(data.worksets[0].files, ['src/lib/b.ts', 'test/a.test.ts']);
		assert.deepEqual(data.worksets[0].folders, ['docs']);
		assert.equal(data.activeWorksetId, undefined, 'active selection is not written to the repo');

		data.worksets.push({ id: 'ext1', name: 'External', files: ['src/a.ts'] });
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(data)));
		await waitFor(() => api.store.all.some((w) => w.name === 'External'), 'external edit to be loaded');
		assert.equal(api.store.active?.name, 'Task A');
	});

	test('switching worksets only changes the views', async () => {
		let doc = await vscode.workspace.openTextDocument(uri('src/a.ts'));
		await vscode.window.showTextDocument(doc);
		let tabsBefore = tabCount();
		let taskA = api.store.active?.id;

		await vscode.commands.executeCommand('fileWorksets.activateWorkset', 'ext1');
		assert.equal(api.store.active?.name, 'External');
		assert.equal(api.activeView.title, 'External');
		assert.deepEqual(await labels(), ['src']);

		await vscode.commands.executeCommand('fileWorksets.activateWorkset', taskA);
		assert.equal(api.store.active?.name, 'Task A');
		assert.equal(tabCount(), tabsBefore);
		assert.ok(await exists(uri('src/lib/c.ts')));
	});

	test('remove from workset removes the reference, not the file', async () => {
		let lib = await child(undefined, 'src/lib');
		let b = await child(lib, 'b.ts');
		await vscode.commands.executeCommand('fileWorksets.removeFromWorkset', b, [b]);
		assert.ok(!activePaths().includes('file:src/lib/b.ts'));
		assert.ok(await exists(uri('src/lib/b.ts')));
	});

	test('renames update references; deleted files stay as missing', async () => {
		await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/lib/c.ts'));
		let edit = new vscode.WorkspaceEdit();
		edit.renameFile(uri('src/lib/c.ts'), uri('src/lib/renamed.ts'));
		assert.ok(await vscode.workspace.applyEdit(edit));
		await waitFor(() => activePaths().includes('file:src/lib/renamed.ts'), 'rename to be applied');

		await vscode.workspace.fs.delete(uri('src/lib/renamed.ts'));
		let lib = await child(undefined, 'src/lib');
		let missing = await child(lib, 'renamed.ts');
		assert.equal(missing.missing, true);
		assert.equal(api.activeFiles.getTreeItem(missing).command, undefined);
		assert.ok(activePaths().includes('file:src/lib/renamed.ts'), 'reference is kept');
	});

	test('context menu file operations: new file, rename and delete', async () => {
		await vscode.workspace.getConfiguration('files').update('enableTrash', false, vscode.ConfigurationTarget.Workspace);

		let docs = await child(undefined, 'docs');
		let nested = await api.actions.createIn(docs, 'file', 'sub/created.md');
		assert.ok(nested && (await exists(nested)));
		assert.ok(!activePaths().some((p) => p.includes('created.md')), 'covered by the docs folder entry');

		let testFolder = await child(undefined, 'test');
		await api.actions.createIn(testFolder, 'file', 'b.test.ts');
		assert.ok(activePaths().includes('file:test/b.test.ts'));

		assert.ok(await api.actions.renameOnDisk(await child(testFolder, 'b.test.ts'), 'c.test.ts'));
		await waitFor(() => activePaths().includes('file:test/c.test.ts'), 'rename to update the reference');
		assert.ok(await exists(uri('test/c.test.ts')));

		assert.equal(await api.actions.deleteOnDisk([await child(testFolder, 'c.test.ts')], false), 1);
		assert.ok(!(await exists(uri('test/c.test.ts'))));
		await waitFor(() => !activePaths().includes('file:test/c.test.ts'), 'reference to be removed from the workset');
	});

	test('dropping Explorer files and tree items onto a workset copies them', async () => {
		let external = api.store.all.find((w) => w.name === 'External');
		assert.ok(external);
		let target = { kind: 'workset', id: external.id } as const;

		let fromExplorer = new vscode.DataTransfer();
		fromExplorer.set('text/uri-list', new vscode.DataTransferItem(uri('src/lib/b.ts').toString()));
		await api.worksets.handleDrop(target, fromExplorer);

		// Drag an implicit folder from Workset Files: copies only the entries under it, not its disk siblings.
		let docs = await child(undefined, 'docs');
		let lib = await child(undefined, 'src/lib');
		let fromView = new vscode.DataTransfer();
		api.activeFiles.handleDrag([docs, lib], fromView);
		let serialized = new vscode.DataTransfer();
		for (let [mime, item] of fromView) {
			serialized.set(mime, new vscode.DataTransferItem(await item.asString()));
		}
		await api.worksets.handleDrop(target, serialized);

		let paths = api.store.get(external.id)?.entries.map((e) => `${e.kind}:${e.path}`);
		assert.deepEqual(paths, ['file:src/a.ts', 'file:src/lib/b.ts', 'folder:docs', 'file:src/lib/renamed.ts']);
		assert.ok(activePaths().includes('folder:docs'), 'copy keeps the source');

		// Dropping a workset's own items back onto it is a no-op.
		let self = new vscode.DataTransfer();
		api.worksets.handleDrag([target], self);
		let before = api.store.get(external.id)?.entries.length;
		await api.worksets.handleDrop(target, self);
		assert.equal(api.store.get(external.id)?.entries.length, before);
	});

	test('auto-add: opened adds pinned tabs, not previews; edited adds only typing in the active editor', async () => {
		let has = (path: string): boolean => activePaths().includes(`file:${path}`);
		let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(!has('src/a.ts') && !has('src/lib/b.ts'));

		try {
			await vscode.commands.executeCommand('fileWorksets.setAutoAdd', 'opened');
			await vscode.window.showTextDocument(uri('src/a.ts'), { preview: true });
			await sleep(300);
			assert.ok(!has('src/a.ts'), 'preview tabs are not added');
			await vscode.window.showTextDocument(uri('src/a.ts'), { preview: false });
			await waitFor(() => has('src/a.ts'), 'pinned tab to be added');

			await vscode.commands.executeCommand('fileWorksets.setAutoAdd', 'edited');
			let b = await vscode.workspace.openTextDocument(uri('src/lib/b.ts'));
			let edit = new vscode.WorkspaceEdit();
			edit.insert(b.uri, new vscode.Position(0, 0), '// background\n');
			assert.ok(await vscode.workspace.applyEdit(edit));
			await sleep(300);
			assert.ok(!has('src/lib/b.ts'), 'edits outside the active editor are not added');

			let editor = await vscode.window.showTextDocument(b, { preview: true });
			await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '// typed\n'));
			await waitFor(() => has('src/lib/b.ts'), 'edited file to be added');
		} finally {
			// Reset to the default.
			await vscode.workspace.getConfiguration('fileWorksets').update('autoAdd', undefined, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('workbench.action.files.revert');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	test('selects the active editor in Workset Files, following explorer.autoReveal settings', async () => {
		let selected = (): string | undefined => api.activeView.selection[0]?.path;
		let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
		let explorer = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('explorer');
		await vscode.commands.executeCommand('fileWorksets.files.focus');

		try {
			await vscode.window.showTextDocument(uri('src/a.ts'));
			await waitFor(() => selected() === 'src/a.ts', 'explicit file to be selected');
			await vscode.window.showTextDocument(uri('docs/readme.md'));
			await waitFor(() => selected() === 'docs/readme.md', 'file inside a folder entry to be selected');

			await explorer().update('autoReveal', false, vscode.ConfigurationTarget.Global);
			await vscode.window.showTextDocument(uri('test/a.test.ts'));
			await sleep(400);
			assert.equal(selected(), 'docs/readme.md', 'nothing is revealed when explorer.autoReveal is off');

			await explorer().update('autoReveal', undefined, vscode.ConfigurationTarget.Global);
			await explorer().update('autoRevealExclude', { '**/lib': true }, vscode.ConfigurationTarget.Global);
			await vscode.window.showTextDocument(uri('src/lib/b.ts'));
			await sleep(400);
			assert.notEqual(selected(), 'src/lib/b.ts', 'files under excluded folders are not revealed');
		} finally {
			await explorer().update('autoReveal', undefined, vscode.ConfigurationTarget.Global);
			await explorer().update('autoRevealExclude', undefined, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	test('restoring an older version of the storage file externally is picked up', async () => {
		await api.store.flush();
		let file = uri('.vscode/file-worksets.json');
		let older = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
		await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Temporary');
		await api.store.flush();
		assert.ok(api.store.all.some((w) => w.name === 'Temporary'));

		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(older));
		await waitFor(() => !api.store.all.some((w) => w.name === 'Temporary'), 'older content to be reloaded');
	});

	test('deleting in VS Code removes the file from all worksets; it comes back if restored', async () => {
		let previous = api.store.active?.id;
		let target = uri('src/to-delete.ts');
		await vscode.workspace.fs.writeFile(target, new TextEncoder().encode('// delete me'));
		try {
			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Delete B');
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', target);
			let second = api.store.active;
			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Delete A');
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', target);
			let first = api.store.active;
			assert.ok(first && second && first.id !== second.id);
			let inBoth = (): [boolean, boolean] => [first, second].map(
				(w) => api.store.get(w.id)?.entries.some((e) => e.path === 'src/to-delete.ts') ?? false,
			) as [boolean, boolean];
			assert.deepEqual(inBoth(), [true, true]);

			// Like deleting from the Explorer: goes through a workspace edit and fires onDidDeleteFiles.
			let edit = new vscode.WorkspaceEdit();
			edit.deleteFile(target);
			assert.ok(await vscode.workspace.applyEdit(edit));
			await waitFor(() => inBoth().every((v) => !v), 'deleted file to be removed from both worksets');

			// Like `git restore`: the file reappears on disk outside of VS Code's edit APIs.
			await vscode.workspace.fs.writeFile(target, new TextEncoder().encode('// delete me'));
			await waitFor(() => inBoth().every(Boolean), 'restored file to be re-added to both worksets');
		} finally {
			if (previous) {
				api.store.setActive(previous);
			}
		}
	});

	test('no active workset: deactivating leaves all worksets untouched while editing', async () => {
		let previous = api.store.active?.id;
		assert.ok(previous);
		let snapshot = (): string => JSON.stringify(api.store.all.map((w) => w.entries));
		let activeId = (): string | undefined => api.store.active?.id;
		try {
			await vscode.commands.executeCommand('fileWorksets.deactivateWorkset');
			assert.equal(activeId(), undefined);
			assert.equal(api.activeView.title, 'Workset Files');
			assert.deepEqual(await children(), []);

			// Auto-add defaults to edited files; with no active workset nothing may change.
			let before = snapshot();
			let editor = await vscode.window.showTextDocument(uri('test/a.test.ts'));
			await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '// typed\n'));
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(snapshot(), before);

			// Explicitly adding a file creates a new unnamed workset, labeled by its creation time.
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/a.ts'));
			let created = api.store.active;
			assert.ok(created && created.id !== previous);
			assert.equal(created.name, '');
			assert.match(api.activeView.title ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
			assert.deepEqual(created.entries.map((e) => e.path), ['src/a.ts']);
			api.actions.deleteWorksets([created.id]);
		} finally {
			await vscode.commands.executeCommand('workbench.action.files.revert');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await vscode.commands.executeCommand('fileWorksets.activateWorkset', previous);
		}
		assert.equal(activeId(), previous);
	});

	test('marks files of the active workset in the Explorer (tint by default, folder entry itself only)', async () => {
		let previous = api.store.active?.id;
		let config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('fileWorksets');
		let decoration = (path: string): vscode.FileDecoration | undefined =>
			api.decorations.provideFileDecoration(uri(path));
		try {
			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Decorations');
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/a.ts'), [uri('src/a.ts'), uri('docs')]);

			assert.ok(decoration('src/a.ts')?.color, 'tinted by default');
			assert.equal(decoration('src/a.ts')?.badge, undefined, 'no badge by default');
			assert.equal(decoration('src/a.ts')?.propagate, true, 'parent folders get the "contains" dot');
			assert.ok(decoration('docs'));
			assert.equal(decoration('docs/readme.md'), undefined, 'contents of a folder entry are not marked');
			assert.equal(decoration('src/lib/b.ts'), undefined);

			await config().update('explorerDecoration', 'badge', vscode.ConfigurationTarget.Global);
			assert.equal(decoration('src/a.ts')?.badge, '★');
			assert.equal(decoration('src/a.ts')?.color, undefined);
			await config().update('explorerDecoration', 'off', vscode.ConfigurationTarget.Global);
			assert.equal(decoration('src/a.ts'), undefined);
			await config().update('explorerDecoration', undefined, vscode.ConfigurationTarget.Global);

			await vscode.commands.executeCommand('fileWorksets.deactivateWorkset');
			assert.equal(decoration('src/a.ts'), undefined, 'nothing is marked without an active workset');
		} finally {
			await config().update('explorerDecoration', undefined, vscode.ConfigurationTarget.Global);
			let created = api.store.all.find((w) => w.name === 'Decorations');
			if (created) {
				api.actions.deleteWorksets([created.id]);
			}
			if (previous) {
				api.store.setActive(previous);
			}
		}
	});

	test('deleting a workset is immediate and can be undone', async () => {
		let previous = api.store.active?.id;
		let activeId = (): string | undefined => api.store.active?.id;
		try {
			// Through the command: a modal confirmation would block here until the test times out.
			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Delete me');
			let throwaway = api.store.active;
			assert.ok(throwaway);
			await vscode.commands.executeCommand('fileWorksets.deleteWorkset', { kind: 'workset', id: throwaway.id });
			assert.equal(api.store.get(throwaway.id), undefined);

			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Undo me');
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/a.ts'));
			let original = api.store.active;
			assert.ok(original);
			// The notification's Undo button calls the function returned here.
			let undo = api.actions.deleteWorksets([original.id]);
			assert.equal(api.store.get(original.id), undefined);
			assert.equal(activeId(), undefined);
			undo?.();
			assert.deepEqual(api.store.get(original.id), original, 'same id, name, creation time and entries');
			assert.equal(activeId(), original.id, 'it is active again');
		} finally {
			let created = api.store.all.find((w) => w.name === 'Undo me');
			if (created) {
				api.actions.deleteWorksets([created.id]);
			}
			if (previous) {
				api.store.setActive(previous);
			}
		}
	});

	test('removing a folder with several entries does not ask for confirmation', async () => {
		let previous = api.store.active?.id;
		try {
			await vscode.commands.executeCommand('fileWorksets.createWorkset', 'Folder removal');
			await vscode.commands.executeCommand('fileWorksets.addToActiveWorkset', uri('src/a.ts'), [
				uri('src/a.ts'),
				uri('src/lib/b.ts'),
			]);
			let src = await child(undefined, 'src');
			assert.equal(src.origin, 'implicit');
			// A modal confirmation would block here until the test times out.
			await vscode.commands.executeCommand('fileWorksets.removeFromWorkset', src, [src]);
			assert.deepEqual(activePaths(), []);
		} finally {
			if (previous) {
				api.store.setActive(previous);
			}
		}
	});
});
