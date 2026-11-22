import * as vscode from 'vscode';
import { isCovered, makeEntry, pathKey, sanitizeEntries, worksetLabel, type WorksetEntry } from './core/model.ts';
import { isSameOrUnder, sanitizeRelativePath, selfAndAncestors } from './core/paths.ts';
import type { WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

const MEMENTO_KEY = 'fileWorksets.deletedPaths';
/** Per-reference records written by earlier versions; dropped on load. */
const LEGACY_MEMENTO_KEY = 'fileWorksets.recentlyDeleted';
const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESTORE_BATCH_MS = 50;
const STAT_CONCURRENCY = 32;

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function getOrAdd<K, V>(map: Map<K, V>, key: K, create: () => V): V {
	let value = map.get(key);
	if (value === undefined) {
		value = create();
		map.set(key, value);
	}
	return value;
}

interface Ref {
	readonly worksetId: string;
	readonly entry: WorksetEntry;
}

/** One deleted path and the references its deletion removed, keyed by entry path. */
interface Deletion {
	/** Workspace folder name, already resolved (never "the default folder"). */
	readonly root: string | undefined;
	readonly path: string;
	deletedAt: number;
	readonly refs: Map<string, Ref[]>;
}

interface Match {
	readonly deletion: Deletion;
	readonly path: string;
	readonly ref: Ref;
}

interface Restored {
	readonly deletion: Deletion;
	readonly ref: Ref;
	/** The entry actually re-added (rooted if the default folder changed since the delete). */
	readonly entry: WorksetEntry;
}

interface RootPath {
	readonly root: string | undefined;
	readonly path: string;
}

/**
 * Removes references when a file or folder is deleted *in VS Code* (Explorer, Delete commands,
 * workspace edits), and puts them back if the same path reappears within 24 hours (git restore,
 * Discard Changes, undo, switching back to a branch).
 *
 * Deletes from outside VS Code, such as switching git branches, don't fire `onDidDeleteFiles`,
 * so those references are kept and shown as missing.
 *
 * Records are grouped by deleted path, indexed by entry path, and restores are batched, so thousands
 * of records or created files cost O(path depth) per file instead of a scan of all records.
 */
export class DeletionTracker implements vscode.Disposable {
	private readonly deletions: Map<string, Deletion>;
	/** Deletions holding references at each entry path (`pathKey`). */
	private readonly byPath: Map<string, Set<Deletion>>;
	/** Entry paths strictly below each folder (`pathKey`), for a folder that reappears in one event. */
	private readonly below: Map<string, Set<string>>;
	private readonly disposables: vscode.Disposable[];
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;
	private readonly memento: vscode.Memento;
	private pending: vscode.Uri[];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(store: WorksetStore, roots: WorkspaceRoots, memento: vscode.Memento) {
		this.store = store;
		this.roots = roots;
		this.memento = memento;
		this.deletions = new Map();
		this.byPath = new Map();
		this.below = new Map();
		this.pending = [];
		this.load();
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
		if (!this.store.changeable) {
			return;
		}
		let defaultRoot = this.roots.defaultRoot();
		let deleted = new Set<string>();
		for (let uri of uris) {
			let location = this.roots.locate(uri);
			if (location) {
				deleted.add(pathKey(location.root, location.path, defaultRoot));
			}
		}
		if (deleted.size === 0) {
			return;
		}
		let now = Date.now();
		let removedCount = 0;
		let names = new Set<string>();
		for (let workset of this.store.all) {
			let kept: WorksetEntry[] = [];
			for (let entry of workset.entries) {
				let root = entry.root ?? defaultRoot;
				let deletedPath = selfAndAncestors(entry.path).find((path) => deleted.has(pathKey(root, path, undefined)));
				if (deletedPath === undefined) {
					kept.push(entry);
				} else {
					this.record(root, deletedPath, now, { worksetId: workset.id, entry });
				}
			}
			if (kept.length < workset.entries.length) {
				this.store.setEntries(workset.id, kept, true);
				removedCount += workset.entries.length - kept.length;
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

	private record(root: string | undefined, path: string, deletedAt: number, ref: Ref): void {
		let deletion = getOrAdd(this.deletions, pathKey(root, path, undefined), () => ({
			root,
			path,
			deletedAt,
			refs: new Map<string, Ref[]>(),
		}));
		deletion.deletedAt = Math.max(deletion.deletedAt, deletedAt);
		let entryPath = ref.entry.path;
		let refs = (deletion.refs.get(entryPath) ?? []).filter(
			(r) => r.worksetId !== ref.worksetId || r.entry.kind !== ref.entry.kind,
		);
		refs.push(ref);
		deletion.refs.set(entryPath, refs);
		getOrAdd(this.byPath, pathKey(root, entryPath, undefined), () => new Set()).add(deletion);
		for (let ancestor of selfAndAncestors(entryPath)) {
			if (ancestor !== entryPath) {
				getOrAdd(this.below, pathKey(root, ancestor, undefined), () => new Set()).add(entryPath);
			}
		}
	}

	/** Forgets a deletion's references at one entry path, and the deletion once it holds none. */
	private forget(deletion: Deletion, entryPath: string): void {
		deletion.refs.delete(entryPath);
		let key = pathKey(deletion.root, entryPath, undefined);
		let holders = this.byPath.get(key);
		holders?.delete(deletion);
		if (holders?.size === 0) {
			this.byPath.delete(key);
			for (let ancestor of selfAndAncestors(entryPath)) {
				let folderKey = pathKey(deletion.root, ancestor, undefined);
				let paths = this.below.get(folderKey);
				paths?.delete(entryPath);
				if (paths?.size === 0) {
					this.below.delete(folderKey);
				}
			}
		}
		let deletionKey = pathKey(deletion.root, deletion.path, undefined);
		if (deletion.refs.size === 0 && this.deletions.get(deletionKey) === deletion) {
			this.deletions.delete(deletionKey);
		}
	}

	/** Matches for references at `path` (any kind) or at its parent folders (folder entries only). */
	private matchesAt(root: string | undefined, path: string, matches: Match[]): void {
		let chain = selfAndAncestors(path);
		for (let i = 0; i < chain.length; i++) {
			let at = chain[i]!;
			let isSelf = i === chain.length - 1;
			for (let deletion of this.byPath.get(pathKey(root, at, undefined)) ?? []) {
				for (let ref of deletion.refs.get(at) ?? []) {
					if (isSelf || ref.entry.kind === 'folder') {
						matches.push({ deletion, path: at, ref });
					}
				}
			}
		}
	}

	/**
	 * Re-adds references for a path that was deleted in VS Code and has now reappeared. Calls are
	 * batched, so a burst of events (e.g. a branch switch) becomes one update per workset.
	 */
	restore(uri: vscode.Uri): void {
		if (this.deletions.size === 0) {
			return;
		}
		this.pending.push(uri);
		this.timer ??= setTimeout(() => void this.flush(), RESTORE_BATCH_MS);
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		let uris = this.pending;
		this.pending = [];
		let defaultRoot = this.roots.defaultRoot();
		let candidates = new Map<string, RootPath>();
		let add = (root: string | undefined, path: string): void => {
			candidates.set(pathKey(root, path, undefined), { root, path });
		};
		for (let uri of uris) {
			let location = this.roots.locate(uri);
			if (!location) {
				continue;
			}
			let root = location.root ?? defaultRoot;
			if (selfAndAncestors(location.path).some((path) => this.byPath.has(pathKey(root, path, undefined)))) {
				add(root, location.path);
			}
			// A restored folder may arrive as a single event; what was below it needs checking too.
			for (let path of this.below.get(pathKey(root, location.path, undefined)) ?? []) {
				add(root, path);
			}
		}
		if (candidates.size === 0) {
			return;
		}
		// Events can arrive late (e.g. for a file created just before it was deleted), so only paths
		// that exist now count. A path that exists also means its parent folders do.
		let items = [...candidates.values()];
		let found = await this.existing(items);
		let matches: Match[] = [];
		items.forEach((item, index) => {
			if (found[index]) {
				this.matchesAt(item.root, item.path, matches);
			}
		});
		this.take(matches);
	}

	/**
	 * Restores records whose paths exist again. Run after loading, to catch files restored while
	 * VS Code was closed (no create event is fired for those).
	 */
	async reconcile(retry = true): Promise<void> {
		let matches: Match[] = [];
		for (let deletion of [...this.deletions.values()]) {
			let base = this.roots.uriFor(deletion.root, deletion.path);
			// Nothing below a path that's still missing can exist.
			if (!base || !(await exists(base))) {
				continue;
			}
			let paths = [...deletion.refs.keys()];
			let found = await this.existing(paths.map((path) => ({ root: deletion.root, path })));
			paths.forEach((path, index) => {
				if (found[index]) {
					for (let ref of deletion.refs.get(path) ?? []) {
						matches.push({ deletion, path, ref });
					}
				}
			});
		}
		this.take(matches, retry);
	}

	private async existing(items: readonly RootPath[]): Promise<boolean[]> {
		let result: boolean[] = [];
		for (let start = 0; start < items.length; start += STAT_CONCURRENCY) {
			let batch = items.slice(start, start + STAT_CONCURRENCY).map((item) => {
				let uri = this.roots.uriFor(item.root, item.path);
				return uri ? exists(uri) : false;
			});
			result.push(...(await Promise.all(batch)));
		}
		return result;
	}

	/**
	 * Re-adds matched references, one update per workset, and forgets them. A reference whose workset
	 * is temporarily unavailable (e.g. while storage reloads) stays until restored or expired.
	 */
	private take(matches: readonly Match[], retry = true): void {
		if (!this.store.changeable) {
			return;
		}
		let pruned = this.prune();
		let defaultRoot = this.roots.defaultRoot();
		let byWorkset = new Map<string, WorksetEntry[]>();
		let restored: Restored[] = [];
		for (let { deletion, path, ref } of matches) {
			let refs = deletion.refs.get(path);
			let index = refs?.indexOf(ref) ?? -1;
			if (!refs || index === -1 || !this.store.get(ref.worksetId)) {
				continue;
			}
			refs.splice(index, 1);
			if (refs.length === 0) {
				this.forget(deletion, path);
			}
			// Restore into the folder it was deleted from; a rootless entry may now resolve to another one.
			let entry =
				ref.entry.root === undefined && deletion.root !== defaultRoot
					? makeEntry(ref.entry.kind, ref.entry.path, deletion.root)
					: ref.entry;
			getOrAdd(byWorkset, ref.worksetId, () => []).push(entry);
			restored.push({ deletion, ref, entry });
		}
		for (let [id, entries] of byWorkset) {
			this.store.addEntries(id, entries, true);
		}
		if (pruned || byWorkset.size) {
			this.save();
		}
		if (restored.length) {
			void this.confirm(restored, retry);
		}
	}

	/**
	 * Puts records back for restored references that didn't reach storage, e.g. when the save hit an
	 * outside edit and that version was loaded instead. Then tries once more against the loaded version.
	 */
	private async confirm(restored: readonly Restored[], retry: boolean): Promise<void> {
		await this.store.settled();
		let defaultRoot = this.roots.defaultRoot();
		let lost = restored.filter(({ ref, entry }) => {
			let workset = this.store.get(ref.worksetId);
			return !workset || !isCovered(workset.entries, entry, defaultRoot);
		});
		if (lost.length === 0) {
			return;
		}
		for (let { deletion, ref } of lost) {
			this.record(deletion.root, deletion.path, deletion.deletedAt, ref);
		}
		this.save();
		if (retry) {
			await this.reconcile(false);
		}
	}

	/** Drops expired records; returns whether any were dropped. */
	private prune(): boolean {
		let cutoff = Date.now() - RESTORE_WINDOW_MS;
		let pruned = false;
		for (let deletion of [...this.deletions.values()]) {
			if (deletion.deletedAt < cutoff) {
				for (let path of [...deletion.refs.keys()]) {
					this.forget(deletion, path);
				}
				pruned = true;
			}
		}
		return pruned;
	}

	private load(): void {
		if (this.memento.get(LEGACY_MEMENTO_KEY) !== undefined) {
			void this.memento.update(LEGACY_MEMENTO_KEY, undefined);
		}
		let raw = this.memento.get<unknown>(MEMENTO_KEY);
		if (!Array.isArray(raw)) {
			return;
		}
		let cutoff = Date.now() - RESTORE_WINDOW_MS;
		for (let item of raw) {
			let record = item as { root?: unknown; path?: unknown; deletedAt?: unknown; refs?: unknown };
			let path = sanitizeRelativePath(record.path, false);
			let root = typeof record.root === 'string' ? record.root : undefined;
			if (path === undefined || typeof record.deletedAt !== 'number' || record.deletedAt < cutoff || !Array.isArray(record.refs)) {
				continue;
			}
			for (let rawRef of record.refs) {
				let ref = rawRef as { worksetId?: unknown; entry?: unknown };
				let [entry] = sanitizeEntries([ref.entry]);
				if (entry && typeof ref.worksetId === 'string' && isSameOrUnder(entry.path, path)) {
					this.record(root, path, record.deletedAt, {
						worksetId: ref.worksetId,
						entry: makeEntry(entry.kind, entry.path, entry.root),
					});
				}
			}
		}
	}

	private save(): void {
		// Records expire after 24 hours, which keeps the list bounded without dropping valid ones.
		this.prune();
		let data = [...this.deletions.values()].map((deletion) => ({
			root: deletion.root,
			path: deletion.path,
			deletedAt: deletion.deletedAt,
			refs: [...deletion.refs.values()].flat(),
		}));
		void this.memento.update(MEMENTO_KEY, data);
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
