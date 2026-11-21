import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
	addEntries,
	parseWorksets,
	renameEntries,
	serializeWorksets,
	type Workset,
	type WorksetEntry,
} from './core/model.ts';
import type { Location, WorkspaceRoots } from './roots.ts';
import type { StorageBackend } from './storage.ts';

const ACTIVE_KEY = 'fileWorksets.activeWorksetId';
const LAST_USED_KEY = 'fileWorksets.lastUsed';

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
	private writeChain: Promise<void> = Promise.resolve();
	private reloadChain: Promise<void> = Promise.resolve();
	private readonly memento: vscode.Memento;
	private readonly roots: WorkspaceRoots;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private markReady: () => void = () => undefined;
	/** Resolves once worksets have been loaded for the first time. */
	readonly ready = new Promise<void>((resolve) => (this.markReady = resolve));

	constructor(memento: vscode.Memento, roots: WorkspaceRoots) {
		this.memento = memento;
		this.roots = roots;
		this.activeId = memento.get<string>(ACTIVE_KEY);
		this.lastUsed = { ...memento.get<Record<string, string>>(LAST_USED_KEY, {}) };
	}

	get hasStorage(): boolean {
		return this.backend !== undefined;
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
	 * Switches storage. With `migrate`, current worksets are copied into the new
	 * backend when it has none of its own.
	 */
	async useBackend(backend: StorageBackend | undefined, migrate = false): Promise<void> {
		let previous = this.worksets;
		this.backendListener?.dispose();
		this.backend?.dispose();
		this.backend = backend;
		this.backendListener = backend?.onDidChangeExternally(() => void this.reload());
		this.generation++;
		this.lastPersisted = undefined;
		this.lastQueued = undefined;
		this.loadError = undefined;
		this.worksets = [];
		await this.reload();
		if (migrate && previous.length > 0 && this.worksets.length === 0 && !this.loadError) {
			this.worksets = previous;
			this.save();
		}
		this.markReady();
	}

	/** Reloads from the backend. Reloads run one at a time, after pending writes. */
	private reload(): Promise<void> {
		this.reloadChain = this.reloadChain.then(() => this.doReload());
		return this.reloadChain;
	}

	private async doReload(): Promise<void> {
		let backend = this.backend;
		if (!backend) {
			this.fire();
			return;
		}
		// Let our own writes land first so their watcher events are recognized as ours.
		await this.writeChain;
		let generation = this.generation;
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
		if (text !== undefined && text === this.lastPersisted && !this.loadError) {
			return;
		}
		if (text === undefined) {
			this.worksets = [];
		} else {
			try {
				this.worksets = parseWorksets(text, () => this.newId());
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
			`File Worksets: Could not read ${backend.description} (${this.loadError}). Changes will not be saved until it is fixed.`,
		);
	}

	create(name: string, entries: readonly WorksetEntry[] = [], activate = true): Workset {
		let workset: Workset = {
			id: this.newId(),
			name: name.trim(),
			createdAt: new Date().toISOString(),
			entries: addEntries([], entries, this.roots.defaultRoot()).entries,
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
		if (!this.get(id)) {
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
	 */
	restore(worksets: readonly Workset[], lastUsed: Readonly<Record<string, string>>, activeId?: string): void {
		let restored = worksets.filter((w) => !this.get(w.id));
		if (restored.length === 0) {
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
	addEntries(id: string, entries: readonly WorksetEntry[]): WorksetEntry[] {
		let added: WorksetEntry[] = [];
		this.update(id, (w) => {
			let result = addEntries(w.entries, entries, this.roots.defaultRoot());
			added = result.added;
			return added.length ? { ...w, entries: result.entries } : w;
		});
		return added;
	}

	setEntries(id: string, entries: readonly WorksetEntry[]): void {
		this.update(id, (w) => ({ ...w, entries }));
	}

	/** Updates references in every workset after a file or folder was renamed or moved. */
	applyRename(from: Location, to: Location): void {
		let changed = false;
		this.worksets = this.worksets.map((w) => {
			let result = renameEntries(w.entries, from, to, this.roots.defaultRoot());
			changed ||= result.changed;
			return result.changed ? { ...w, entries: result.entries } : w;
		});
		if (changed) {
			this.save();
		}
	}

	/** Resolves once all pending writes have completed. */
	flush(): Promise<void> {
		return this.writeChain;
	}

	dispose(): void {
		this.backendListener?.dispose();
		this.backend?.dispose();
		this.changeEmitter.dispose();
	}

	private update(id: string, fn: (w: Workset) => Workset): void {
		let index = this.worksets.findIndex((w) => w.id === id);
		let current = this.worksets[index];
		if (!current) {
			return;
		}
		let next = fn(current);
		if (next === current) {
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
		if (!backend) {
			return;
		}
		if (this.loadError) {
			void vscode.window.showWarningMessage(
				`File Worksets: Not saved because ${backend.description} could not be read. Fix or delete it and try again.`,
			);
			return;
		}
		let content = serializeWorksets(this.worksets);
		if (content === this.lastQueued) {
			return;
		}
		this.lastQueued = content;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await backend.write(content);
				if (this.backend === backend) {
					this.lastPersisted = content;
				}
			} catch (error) {
				// Allow the same content to be retried on the next change.
				if (this.lastQueued === content) {
					this.lastQueued = undefined;
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
