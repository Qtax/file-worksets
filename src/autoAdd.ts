import * as vscode from 'vscode';
import { tabUri } from './actions.ts';
import { makeEntry, worksetLabel } from './core/model.ts';
import type { WorkspaceRoots } from './roots.ts';
import { STORAGE_FILE } from './storage.ts';
import type { WorksetStore } from './store.ts';

export type AutoAddMode = 'off' | 'opened' | 'edited';

export const AUTO_ADD_MODES: readonly { mode: AutoAddMode; label: string; detail: string }[] = [
	{ mode: 'off', label: 'Off', detail: 'Only add files manually.' },
	{
		mode: 'opened',
		label: 'Opened Files',
		detail: 'Add files you open in a regular tab. Single-click previews (italic tabs) are not added.',
	},
	{
		mode: 'edited',
		label: 'Edited Files',
		detail: 'Add files when you type in them. Changes from refactorings or Replace All are not counted.',
	},
];

export function isAutoAddMode(value: unknown): value is AutoAddMode {
	return AUTO_ADD_MODES.some((m) => m.mode === value);
}

export function readAutoAddMode(): AutoAddMode {
	let value = vscode.workspace.getConfiguration('fileWorksets').get<string>('autoAdd', 'edited');
	return isAutoAddMode(value) ? value : 'edited';
}

/**
 * Adds opened or edited files to the active workset, depending on `fileWorksets.autoAdd`.
 * Never prompts and never creates a workset: does nothing while no workset is active.
 */
export class AutoAdder implements vscode.Disposable {
	private mode: AutoAddMode = readAutoAddMode();
	private readonly disposables: vscode.Disposable[];
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;

	constructor(store: WorksetStore, roots: WorkspaceRoots) {
		this.store = store;
		this.roots = roots;
		this.disposables = [
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('fileWorksets.autoAdd')) {
					this.mode = readAutoAddMode();
				}
			}),
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				if (this.mode !== 'opened') {
					return;
				}
				// A preview tab becoming a regular tab (double-click, edit, keep open) shows up as "changed".
				for (let tab of [...event.opened, ...event.changed]) {
					if (!tab.isPreview) {
						this.add(tabUri(tab));
					}
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// Only count typing in the active editor, so multi-file edits (Replace All, rename refactorings) are ignored.
				if (
					this.mode === 'edited' &&
					event.contentChanges.length > 0 &&
					event.document === vscode.window.activeTextEditor?.document
				) {
					this.add(event.document.uri);
				}
			}),
		];
	}

	private add(uri: vscode.Uri | undefined): void {
		let workset = this.store.active;
		let location = uri && this.roots.locate(uri);
		if (!workset || !location) {
			return;
		}
		// Don't add the extension's own storage file when it's opened or edited by hand.
		if (location.path === STORAGE_FILE && this.roots.resolve(location.root)?.index === 0) {
			return;
		}
		let added = this.store.addEntries(workset.id, [makeEntry('file', location.path, location.root)]);
		if (added.length) {
			vscode.window.setStatusBarMessage(`$(add) Added "${location.path}" to "${worksetLabel(workset)}"`, 3000);
		}
	}

	dispose(): void {
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
