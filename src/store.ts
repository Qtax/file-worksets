import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
	addEntries,
	makeEntry,
	parseWorksets,
	renameEntries,
	serializeWorksets,
	type Workset,
	type WorksetEntry,
	type WorksetGit,
} from './core/model.ts';
import type { Location, WorkspaceRoots } from './roots.ts';
import { StorageConflictError, type StorageBackend } from './storage.ts';

const ACTIVE_KEY = 'fileWorksets.activeWorksetId';
const LAST_USED_KEY = 'fileWorksets.lastUsed';

/** Gives a workset's rootless entries an explicit root; returns the same object if there are none. */
function pinEntries(workset: Workset, root: string): Workset {
	if (!workset.entries.some((e) => e.root === undefined)) {
		return workset;
	}
	return { ...workset, entries: workset.entries.map((e) => (e.root === undefined ? makeEntry(e.kind, e.path, root) : e)) };
}

/**
 * Holds all worksets for the current VS Code workspace. Definitions go to the
 * configured storage backend; the active workset and last-used times stay in
 * workspace state so switching never writes to the repository.
 */
export class WorksetStore implements vscode.Disposable {
	private worksets: Workset[] = [];
	private activeId: string | undefined;
	private lastUsed: Record<string, string>;
	private backend: StorageBackend | undefined;
	private backendListener: vscode.Disposable | undefined;
	/** Content known to be on disk (last successful read or write). */
	private lastPersisted: string | undefined;
	/** Content of the most recently queued write, to skip redundant writes. */
	private lastQueued: string | undefined;
	/** Bumped on backend switches and local edits so in-flight reads can detect they're stale. */
	private generation = 0;
	private revision = 0;
	private loadError: string | undefined;
	/** True while a backend is being read for the first time; changes are blocked meanwhile. */
	private loading = false;
	/** Worksets from before a storage switch, kept for migration while switches overlap. */
	private switchPrevious: Workset[] = [];
	private writeChain: Promise<void> = Promise.resolve();
	private reloadChain: Promise<void> = Promise.resolve();
	private readonly memento: vscode.Memento;
	private readonly roots: WorkspaceRoots;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private loaded: Promise<void> = new Promise<void>(() => undefined);
	/** Supplies the Git branch and commit recorded on new worksets, if Git is available. */
	gitOrigin: (() => WorksetGit | undefined) | undefined;

	/** Resolves once the current storage has been read (the first load, or after a storage switch). */
	whenLoaded(): Promise<void> {
		return this.loaded;
	}

	constructor(memento: vscode.Memento, roots: WorkspaceRoots) {
		this.memento = memento;
		this.roots = roots;
		this.activeId = memento.get<string>(ACTIVE_KEY);
		this.lastUsed = { ...memento.get<Record<string, string>>(LAST_USED_KEY, {}) };
	}

	get hasStorage(): boolean {
		return this.backend !== undefined;
	}

	/** Whether worksets can be changed right now (not loading, storage readable). */
	get changeable(): boolean {
		return !this.loading && !this.loadError;
	}

	get all(): readonly Workset[] {
		return this.worksets;
	}

	get active(): Workset | undefined {
		return this.activeId === undefined ? undefined : this.get(this.activeId);
	}

	get(id: string): Workset | undefined {
		return this.worksets.find((w) => w.id === id);
	}

	get lastUsedTimes(): Readonly<Record<string, string>> {
		return this.lastUsed;
	}

	/**
	 * Switches storage. With `migrate`, current worksets are copied into the new backend when it has
	 * none of its own; rootless entries are pinned to `migrate.rootlessOwner` if given, since the new
	 * source may resolve rootless entries differently. Changes are blocked until the new backend has
	 * been read, so nothing can overwrite its contents with a partial list.
	 */
	async useBackend(backend: StorageBackend | undefined, migrate?: { readonly rootlessOwner: string | undefined }): Promise<void> {
		let done = (): void => undefined;
		this.loaded = new Promise<void>((resolve) => (done = resolve));
		// If an earlier switch is still loading, its worksets were already cleared; keep the original ones.
		let previous = this.loading ? this.switchPrevious : this.worksets;
		this.switchPrevious = previous;
		this.backendListener?.dispose();
		this.backend?.dispose();
		this.backend = backend;
		this.backendListener = backend?.onDidChangeExternally(() => void this.reload());
		let generation = ++this.generation;
		this.loading = true;
		this.lastPersisted = undefined;
		this.lastQueued = undefined;
		this.loadError = undefined;
		this.worksets = [];
		try {
			await this.reload();
		} finally {
			// A newer switch started meanwhile; it owns loading, migration and the loaded promise.
			if (generation === this.generation) {
				this.loading = false;
				this.switchPrevious = [];
			}
		}
		if (generation !== this.generation) {
			void this.loaded.then(done);
			return;
		}
		if (migrate && previous.length > 0 && this.worksets.length === 0 && !this.loadError) {
			let owner = migrate.rootlessOwner;
			this.worksets = owner === undefined ? previous : previous.map((w) => pinEntries(w, owner));
			this.save();
		}
		this.fire();
		done();
	}

	/** Reloads from the backend. Reloads run one at a time, after pending writes. */
	private reload(): Promise<void> {
		this.reloadChain = this.reloadChain.then(() => this.doReload());
		return this.reloadChain;
	}

	private async doReload(): Promise<void> {
		let backend = this.backend;
		let generation = this.generation;
		if (!backend) {
			this.fire();
			return;
		}
		// Let our own writes land first so their watcher events are recognized as ours.
		await this.writeChain;
		if (generation !== this.generation) {
			return;
		}
		let revision = this.revision;
		let text: string | undefined;
		try {
			text = await backend.read();
		} catch (error) {
			if (generation === this.generation) {
				this.reportLoadError(backend, error);
			}
			return;
		}
		// Discard reads that raced with a backend switch or local edits (those get saved instead).
		if (generation !== this.generation || revision !== this.revision) {
			return;
		}
		// During a backend's first load the content must always be parsed: nothing is known about it yet.
		if (text !== undefined && text === this.lastPersisted && !this.loadError && !this.loading) {
			return;
		}
		if (text === undefined) {
			this.worksets = [];
		} else {
			try {
				this.worksets = parseWorksets(text, () => this.newId(), { backslashIsSeparator: process.platform === 'win32' });
			} catch (error) {
				this.reportLoadError(backend, error);
				return;
			}
		}
		this.lastPersisted = text;
		this.lastQueued = text;
		this.loadError = undefined;
		// Keep activeId even if it's not present now (e.g. the file is missing on another branch);
		// `active` resolves to undefined until it comes back.
		this.fire();
	}

	private reportLoadError(backend: StorageBackend, error: unknown): void {
		this.loadError = error instanceof Error ? error.message : String(error);
		this.fire();
		void vscode.window.showWarningMessage(
			`File Worksets: Could not read ${backend.description} (${this.loadError}). Worksets can't be changed until it's fixed.`,
		);
	}

	/**
	 * Whether changes are allowed right now. They're blocked while loading and while the storage
	 * can't be read, since they'd be lost or overwrite data. `quiet` skips the warning (automatic changes).
	 */
	private canChange(quiet = false): boolean {
		if (!this.loading && !this.loadError) {
			return true;
		}
		if (!quiet) {
			let reason = this.loading
				? 'Worksets are still loading. Try again in a moment.'
				: `${this.backend?.description ?? 'The storage'} could not be read (${this.loadError}). Fix or delete it first.`;
			void vscode.window.showWarningMessage(`File Worksets: ${reason}`);
		}
		return false;
	}

	create(name: string, entries: readonly WorksetEntry[] = [], activate = true): Workset | undefined {
		if (!this.canChange()) {
			return undefined;
		}
		let git = this.gitOrigin?.();
		let workset: Workset = {
			id: this.newId(),
			name: name.trim(),
			createdAt: new Date().toISOString(),
			entries: addEntries([], entries, this.roots.defaultRoot()).entries,
			...(git ? { git } : {}),
		};
		this.worksets = [...this.worksets, workset];
		if (activate) {
			this.setActiveId(workset.id);
		}
		this.save();
		return workset;
	}

	rename(id: string, name: string): void {
		this.update(id, (w) => ({ ...w, name: name.trim() }));
	}

	delete(id: string): void {
		if (!this.get(id) || !this.canChange()) {
			return;
		}
		this.worksets = this.worksets.filter((w) => w.id !== id);
		delete this.lastUsed[id];
		void this.memento.update(LAST_USED_KEY, this.lastUsed);
		if (this.activeId === id) {
			this.setActiveId(undefined);
		}
		this.save();
	}

	/**
	 * Puts deleted worksets back with their IDs, creation times, entries and last-used times.
	 * A name taken in the meantime is dropped (the workset becomes unnamed) to keep names unique.
	 * The workset becomes active again only if no other workset was activated in the meantime.
	 */
	restore(worksets: readonly Workset[], lastUsed: Readonly<Record<string, string>>, activeId?: string): void {
		let restored = worksets.filter((w) => !this.get(w.id));
		if (restored.length === 0 || !this.canChange()) {
			return;
		}
		for (let workset of restored) {
			let nameTaken = workset.name && this.worksets.some((w) => w.name.toLowerCase() === workset.name.toLowerCase());
			this.worksets = [...this.worksets, nameTaken ? { ...workset, name: '' } : workset];
			let used = lastUsed[workset.id];
			if (used) {
				this.lastUsed[workset.id] = used;
			}
		}
		void this.memento.update(LAST_USED_KEY, this.lastUsed);
		if (activeId !== undefined && this.activeId === undefined && restored.some((w) => w.id === activeId)) {
			// Set directly so restoring doesn't count as a new "use".
			this.activeId = activeId;
			void this.memento.update(ACTIVE_KEY, activeId);
		}
		this.save();
	}

	setActive(id: string | undefined): void {
		if (id !== undefined && !this.get(id)) {
			return;
		}
		this.setActiveId(id);
		this.fire();
	}

	/** Adds entries, skipping ones already included. Returns the entries actually added. */
	addEntries(id: string, entries: readonly WorksetEntry[], quiet = false): WorksetEntry[] {
		let added: WorksetEntry[] = [];
		this.update(
			id,
			(w) => {
				let result = addEntries(w.entries, entries, this.roots.defaultRoot());
				added = result.added;
				return added.length ? { ...w, entries: result.entries } : w;
			},
			quiet,
		);
		return added;
	}

	setEntries(id: string, entries: readonly WorksetEntry[], quiet = false): void {
		this.update(id, (w) => ({ ...w, entries }), quiet);
	}

	/**
	 * Gives entries stored without a root an explicit one. Used when workspace folders change, so
	 * references keep pointing at the folder they were added from.
	 */
	pinRootless(root: string): void {
		let next = this.worksets.map((w) => pinEntries(w, root));
		if (next.some((w, i) => w !== this.worksets[i]) && this.canChange(true)) {
			this.worksets = next;
			this.save();
		}
	}

	/** Updates references in every workset after a file or folder was renamed or moved. */
	applyRename(from: Location, to: Location): void {
		let changed = false;
		let next = this.worksets.map((w) => {
			let result = renameEntries(w.entries, from, to, this.roots.defaultRoot());
			changed ||= result.changed;
			return result.changed ? { ...w, entries: result.entries } : w;
		});
		if (changed && this.canChange(true)) {
			this.worksets = next;
			this.save();
		}
	}

	/** Resolves once all pending writes have completed. */
	flush(): Promise<void> {
		return this.writeChain;
	}

	/** Resolves once pending writes and any reloads they triggered (e.g. after a conflict) are done. */
	async settled(): Promise<void> {
		await this.writeChain;
		await this.reloadChain;
	}

	dispose(): void {
		this.backendListener?.dispose();
		this.backend?.dispose();
		this.changeEmitter.dispose();
	}

	private update(id: string, fn: (w: Workset) => Workset, quiet = false): void {
		let index = this.worksets.findIndex((w) => w.id === id);
		let current = this.worksets[index];
		if (!current) {
			return;
		}
		let next = fn(current);
		if (next === current || !this.canChange(quiet)) {
			return;
		}
		this.worksets = this.worksets.with(index, next);
		this.save();
	}

	private setActiveId(id: string | undefined): void {
		this.activeId = id;
		void this.memento.update(ACTIVE_KEY, id);
		if (id !== undefined) {
			this.lastUsed[id] = new Date().toISOString();
			void this.memento.update(LAST_USED_KEY, this.lastUsed);
		}
	}

	private save(): void {
		this.revision++;
		this.fire();
		let backend = this.backend;
		if (!backend || this.loadError) {
			return;
		}
		let content = serializeWorksets(this.worksets);
		if (content === this.lastQueued) {
			return;
		}
		this.lastQueued = content;
		let generation = this.generation;
		this.writeChain = this.writeChain.then(async () => {
			if (this.backend !== backend || generation !== this.generation) {
				return;
			}
			try {
				// Only overwrite what we last read or wrote; anything else was changed outside VS Code.
				await backend.write(content, this.lastPersisted);
				// A storage switch while writing must not mark the new backend as holding this content.
				if (generation === this.generation) {
					this.lastPersisted = content;
				}
			} catch (error) {
				if (generation !== this.generation) {
					return;
				}
				// Allow the same content to be retried on the next change.
				if (this.lastQueued === content) {
					this.lastQueued = undefined;
				}
				if (error instanceof StorageConflictError) {
					void vscode.window.showWarningMessage(
						`File Worksets: ${backend.description} was changed outside VS Code, so your last change wasn't saved. Its current content was loaded.`,
					);
					void this.reload();
					return;
				}
				let message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`File Worksets: Failed to save worksets: ${message}`);
			}
		});
	}

	private fire(): void {
		this.changeEmitter.fire();
	}

	private newId(): string {
		let id: string;
		do {
			id = randomUUID().replace(/-/g, '').slice(0, 12);
		} while (this.worksets.some((w) => w.id === id));
		return id;
	}
}
