import { compareNames, isSameOrUnder, replacePrefix, sanitizeRelativePath } from './paths.ts';

export type EntryKind = 'file' | 'folder';

/**
 * A reference to a file or folder. `root` is the workspace folder name; it is
 * undefined in single-folder workspaces and then means "the first folder".
 */
export interface WorksetEntry {
	readonly kind: EntryKind;
	readonly path: string;
	readonly root?: string | undefined;
}

export interface Workset {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly entries: readonly WorksetEntry[];
}

export type SortOrder = 'lastUsed' | 'created' | 'name';

export const STORAGE_VERSION = 1;

export function makeEntry(kind: EntryKind, path: string, root: string | undefined): WorksetEntry {
	return root === undefined ? { kind, path } : { kind, path, root };
}

export function sameRoot(a: string | undefined, b: string | undefined, defaultRoot: string | undefined): boolean {
	return (a ?? defaultRoot) === (b ?? defaultRoot);
}

/** True when the candidate is already in the list, directly or through a folder entry. */
export function isCovered(
	entries: readonly WorksetEntry[],
	candidate: WorksetEntry,
	defaultRoot: string | undefined,
): boolean {
	return entries.some((entry) => {
		if (!sameRoot(entry.root, candidate.root, defaultRoot)) {
			return false;
		}
		if (entry.kind === 'folder') {
			return isSameOrUnder(candidate.path, entry.path);
		}
		return candidate.kind === 'file' && entry.path === candidate.path;
	});
}

export function addEntries(
	entries: readonly WorksetEntry[],
	additions: readonly WorksetEntry[],
	defaultRoot: string | undefined,
): { entries: WorksetEntry[]; added: WorksetEntry[] } {
	let result = [...entries];
	let added: WorksetEntry[] = [];
	for (let addition of additions) {
		if (!isCovered(result, addition, defaultRoot)) {
			result.push(addition);
			added.push(addition);
		}
	}
	return { entries: result, added };
}

/** Removes every entry at or below `path` (`''` means the whole root). */
export function removeUnder(
	entries: readonly WorksetEntry[],
	root: string | undefined,
	path: string,
	defaultRoot: string | undefined,
): { entries: WorksetEntry[]; removed: WorksetEntry[] } {
	let kept: WorksetEntry[] = [];
	let removed: WorksetEntry[] = [];
	for (let entry of entries) {
		if (sameRoot(entry.root, root, defaultRoot) && isSameOrUnder(entry.path, path)) {
			removed.push(entry);
		} else {
			kept.push(entry);
		}
	}
	return { entries: kept, removed };
}

/** Finds the folder entry that includes `path`, if any. */
export function coveringFolder(
	entries: readonly WorksetEntry[],
	root: string | undefined,
	path: string,
	defaultRoot: string | undefined,
): WorksetEntry | undefined {
	return entries.find(
		(entry) => entry.kind === 'folder' && sameRoot(entry.root, root, defaultRoot) && isSameOrUnder(path, entry.path),
	);
}

/** Rewrites entries after a file or folder was renamed/moved. */
export function renameEntries(
	entries: readonly WorksetEntry[],
	from: { root: string | undefined; path: string },
	to: { root: string | undefined; path: string },
	defaultRoot: string | undefined,
): { entries: WorksetEntry[]; changed: boolean } {
	let changed = false;
	let result = entries.map((entry) => {
		if (!sameRoot(entry.root, from.root, defaultRoot)) {
			return entry;
		}
		let path = replacePrefix(entry.path, from.path, to.path);
		if (path === undefined) {
			return entry;
		}
		changed = true;
		return makeEntry(entry.kind, path, to.root);
	});
	return { entries: changed ? dedupeEntries(result) : result, changed };
}

export function dedupeEntries(entries: readonly WorksetEntry[]): WorksetEntry[] {
	let seen = new Set<string>();
	return entries.filter((entry) => {
		let key = `${entry.kind}\u0000${entry.root ?? ''}\u0000${entry.path}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** Empty names are allowed: the workset is then shown by its creation time. */
export function validateWorksetName(
	name: string,
	worksets: readonly Workset[],
	exceptId?: string,
): string | undefined {
	let trimmed = name.trim();
	if (!trimmed) {
		return undefined;
	}
	let lower = trimmed.toLowerCase();
	if (worksets.some((w) => w.id !== exceptId && w.name.toLowerCase() === lower)) {
		return `A workset named "${trimmed}" already exists.`;
	}
	return undefined;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** Local "YYYY-MM-DD HH:mm", used as the label of unnamed worksets. */
export function formatCreatedAt(iso: string): string {
	let date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return 'Unnamed workset';
	}
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What to show for a workset: its name, or its creation time when it has no name. */
export function worksetLabel(workset: Pick<Workset, 'name' | 'createdAt'>): string {
	return workset.name || formatCreatedAt(workset.createdAt);
}

export function sortWorksets(
	worksets: readonly Workset[],
	order: SortOrder,
	lastUsed: Readonly<Record<string, string>>,
): Workset[] {
	let used = (w: Workset): string => lastUsed[w.id] ?? w.createdAt;
	let byName = (a: Workset, b: Workset): number => compareNames(worksetLabel(a), worksetLabel(b));
	let desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
	return [...worksets].sort((a, b) => {
		switch (order) {
			case 'name':
				return byName(a, b);
			case 'created':
				return desc(a.createdAt, b.createdAt) || byName(a, b);
			default:
				return desc(used(a), used(b)) || byName(a, b);
		}
	});
}

type StoredPath = string | { readonly root: string; readonly path: string };

function compareEntries(a: WorksetEntry, b: WorksetEntry): number {
	let ra = a.root ?? '';
	let rb = b.root ?? '';
	if (ra !== rb) {
		return ra < rb ? -1 : 1;
	}
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function toStored(entries: readonly WorksetEntry[], kind: EntryKind): StoredPath[] {
	return entries
		.filter((entry) => entry.kind === kind)
		.sort(compareEntries)
		.map((entry) => (entry.root === undefined ? entry.path : { root: entry.root, path: entry.path }));
}

/** Serializes worksets with sorted paths so the file diffs cleanly in source control. */
export function serializeWorksets(worksets: readonly Workset[]): string {
	let data = {
		version: STORAGE_VERSION,
		worksets: worksets.map((w) => ({
			id: w.id,
			name: w.name,
			createdAt: w.createdAt,
			files: toStored(w.entries, 'file'),
			folders: toStored(w.entries, 'folder'),
		})),
	};
	return `${JSON.stringify(data, null, '\t')}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredPaths(value: unknown, kind: EntryKind): WorksetEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	let entries: WorksetEntry[] = [];
	for (let item of value) {
		if (typeof item === 'string') {
			let path = sanitizeRelativePath(item);
			if (path) {
				entries.push(makeEntry(kind, path, undefined));
			}
		} else if (isRecord(item) && typeof item.root === 'string' && item.root) {
			let path = sanitizeRelativePath(item.path);
			if (path) {
				entries.push(makeEntry(kind, path, item.root));
			}
		}
	}
	return entries;
}

/** Validates entries from untrusted input (e.g. drag-and-drop payloads). */
export function sanitizeEntries(value: unknown): WorksetEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}
	let entries: WorksetEntry[] = [];
	for (let item of value) {
		if (!isRecord(item) || (item.kind !== 'file' && item.kind !== 'folder')) {
			continue;
		}
		let path = sanitizeRelativePath(item.path);
		let root = typeof item.root === 'string' && item.root ? item.root : undefined;
		if (path) {
			entries.push(makeEntry(item.kind, path, root));
		}
	}
	return dedupeEntries(entries);
}

/**
 * Parses stored worksets, dropping anything malformed or unsafe.
 * Throws when the text is not JSON or lacks a `worksets` array.
 */
export function parseWorksets(text: string, newId: () => string): Workset[] {
	let data: unknown = JSON.parse(text);
	if (!isRecord(data) || !Array.isArray(data.worksets)) {
		throw new Error('expected an object with a "worksets" array');
	}
	let ids = new Set<string>();
	let result: Workset[] = [];
	for (let raw of data.worksets) {
		if (!isRecord(raw)) {
			continue;
		}
		// A missing or empty name means "unnamed"; it's shown by its creation time.
		let name = typeof raw.name === 'string' ? raw.name.trim() : '';
		let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newId();
		while (ids.has(id)) {
			id = newId();
		}
		ids.add(id);
		let createdAt =
			typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
				? raw.createdAt
				: new Date(0).toISOString();
		let entries = dedupeEntries([...parseStoredPaths(raw.files, 'file'), ...parseStoredPaths(raw.folders, 'folder')]);
		result.push({ id, name, createdAt, entries });
	}
	return result;
}

export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
	let time = iso === undefined ? Number.NaN : Date.parse(iso);
	if (Number.isNaN(time)) {
		return 'never';
	}
	let minutes = Math.floor(Math.max(0, now - time) / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	let hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	let days = Math.floor(hours / 24);
	if (days < 30) {
		return days === 1 ? 'yesterday' : `${days} days ago`;
	}
	return new Date(time).toISOString().slice(0, 10);
}
