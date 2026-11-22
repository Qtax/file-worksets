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
		detail: 'Add files when their content changes in the active editor. Edits to other files (Replace All, refactorings) are not counted.',
	},
];

export function isAutoAddMode(value: unknown): value is AutoAddMode {
	return AUTO_ADD_MODES.some((m) => m.mode === value);
}

export function readAutoAddMode(): AutoAddMode {
	let value = vscode.workspace.getConfiguration('fileWorksets').get<string>('autoAdd', 'edited');
	return isAutoAddMode(value) ? value : 'edited';
}

function tabKey(tab: vscode.Tab): string | undefined {
	let uri = tabUri(tab);
	return uri && `${tab.group.viewColumn}:${uri.toString()}`;
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
	/** Tabs currently in preview mode, to detect when one becomes a regular tab. */
	private readonly previewTabs = new Set<string>();
	/** The last file handled for the active workset; skips repeated work while typing. */
	private lastAdded: string | undefined;

	constructor(store: WorksetStore, roots: WorkspaceRoots) {
		this.store = store;
		this.roots = roots;
		for (let group of vscode.window.tabGroups.all) {
			for (let tab of group.tabs) {
				this.trackPreview(tab);
			}
		}
		this.disposables = [
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('fileWorksets.autoAdd')) {
					this.mode = readAutoAddMode();
				}
			}),
			store.onDidChange(() => {
				this.lastAdded = undefined;
			}),
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				for (let tab of event.closed) {
					let key = tabKey(tab);
					if (key) {
						this.previewTabs.delete(key);
					}
				}
				for (let tab of event.opened) {
					// Opened as a regular tab (not a single-click preview).
					if (!tab.isPreview && this.mode === 'opened') {
						this.add(tabUri(tab));
					}
					this.trackPreview(tab);
				}
				for (let tab of event.changed) {
					// Only the preview -> regular transition counts, not e.g. becoming the active tab.
					let key = tabKey(tab);
					let wasPreview = key !== undefined && this.previewTabs.has(key);
					if (wasPreview && !tab.isPreview && this.mode === 'opened') {
						this.add(tabUri(tab));
					}
					this.trackPreview(tab);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// Only changes to the active editor's file count, so edits that touch many files
				// (Replace All, rename refactorings) don't add all of them.
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

	private trackPreview(tab: vscode.Tab): void {
		let key = tabKey(tab);
		if (key && tab.isPreview) {
			this.previewTabs.add(key);
		} else if (key) {
			this.previewTabs.delete(key);
		}
	}

	private add(uri: vscode.Uri | undefined): void {
		let workset = this.store.active;
		if (!workset || !uri) {
			return;
		}
		let location = this.roots.locate(uri);
		if (!location) {
			return;
		}
		let key = `${workset.id}:${uri.toString()}`;
		if (key === this.lastAdded) {
			return;
		}
		// Don't add the extension's own storage file when it's opened or edited by hand.
		if (location.path === STORAGE_FILE && this.roots.resolve(location.root)?.index === 0) {
			return;
		}
		let added = this.store.addEntries(workset.id, [makeEntry('file', location.path, location.root)], true);
		// Set after adding: adding fires a change, which clears it.
		this.lastAdded = key;
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
