import * as vscode from 'vscode';
import { makeEntry, removeUnder, sameRoot, sanitizeEntries, worksetLabel, type WorksetEntry } from './core/model.ts';
import type { WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

const MEMENTO_KEY = 'fileWorksets.recentlyDeleted';
const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED = 500;

interface Removed {
	readonly worksetId: string;
	readonly entry: WorksetEntry;
	readonly deletedAt: number;
}

/**
 * Removes references when a file or folder is deleted *in VS Code* (Explorer, Delete commands,
 * workspace edits), and puts them back if the same path reappears within 24 hours (git restore,
 * Discard Changes, undo).
 *
 * Deletes from outside VS Code, such as switching git branches, don't fire `onDidDeleteFiles`,
 * so those references are kept and shown as missing.
 */
export class DeletionTracker implements vscode.Disposable {
	private removed: Removed[];
	private readonly disposables: vscode.Disposable[];
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;
	private readonly memento: vscode.Memento;

	constructor(store: WorksetStore, roots: WorkspaceRoots, memento: vscode.Memento) {
		this.store = store;
		this.roots = roots;
		this.memento = memento;
		this.removed = this.load();
		this.disposables = [
			vscode.workspace.onDidDeleteFiles((event) => this.onDeleted(event.files)),
			vscode.workspace.onDidCreateFiles((event) => {
				for (let uri of event.files) {
					this.restore(uri);
				}
			}),
		];
	}

	private onDeleted(uris: readonly vscode.Uri[]): void {
		let defaultRoot = this.roots.defaultRoot();
		let now = Date.now();
		let removedCount = 0;
		let names = new Set<string>();
		for (let uri of uris) {
			let location = this.roots.locate(uri);
			if (!location) {
				continue;
			}
			for (let workset of this.store.all) {
				let result = removeUnder(workset.entries, location.root, location.path, defaultRoot);
				if (result.removed.length === 0) {
					continue;
				}
				this.store.setEntries(workset.id, result.entries);
				for (let entry of result.removed) {
					this.removed.push({ worksetId: workset.id, entry, deletedAt: now });
				}
				removedCount += result.removed.length;
				names.add(worksetLabel(workset));
			}
		}
		if (removedCount) {
			this.save();
			let where = names.size === 1 ? `"${[...names][0]}"` : `${names.size} worksets`;
			vscode.window.setStatusBarMessage(
				`$(trash) Removed ${removedCount === 1 ? 'deleted item' : `${removedCount} deleted items`} from ${where}`,
				3000,
			);
		}
	}

	/** Re-adds references for a path that was deleted in VS Code and has now reappeared. */
	restore(uri: vscode.Uri): void {
		if (this.removed.length === 0) {
			return;
		}
		let location = this.roots.locate(uri);
		if (!location) {
			return;
		}
		let defaultRoot = this.roots.defaultRoot();
		let cutoff = Date.now() - RESTORE_WINDOW_MS;
		let kept: Removed[] = [];
		let changed = false;
		for (let item of this.removed) {
			if (item.deletedAt < cutoff) {
				changed = true;
				continue;
			}
			if (item.entry.path === location.path && sameRoot(item.entry.root, location.root, defaultRoot)) {
				if (this.store.get(item.worksetId)) {
					this.store.addEntries(item.worksetId, [item.entry]);
				}
				changed = true;
				continue;
			}
			kept.push(item);
		}
		if (changed) {
			this.removed = kept;
			this.save();
		}
	}

	private load(): Removed[] {
		let raw = this.memento.get<unknown>(MEMENTO_KEY);
		if (!Array.isArray(raw)) {
			return [];
		}
		let cutoff = Date.now() - RESTORE_WINDOW_MS;
		let result: Removed[] = [];
		for (let item of raw) {
			let record = item as { worksetId?: unknown; entry?: unknown; deletedAt?: unknown };
			let [entry] = sanitizeEntries([record.entry]);
			if (entry && typeof record.worksetId === 'string' && typeof record.deletedAt === 'number' && record.deletedAt >= cutoff) {
				result.push({ worksetId: record.worksetId, entry: makeEntry(entry.kind, entry.path, entry.root), deletedAt: record.deletedAt });
			}
		}
		return result;
	}

	private save(): void {
		if (this.removed.length > MAX_REMEMBERED) {
			this.removed = this.removed.slice(-MAX_REMEMBERED);
		}
		void this.memento.update(MEMENTO_KEY, this.removed);
	}

	dispose(): void {
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
