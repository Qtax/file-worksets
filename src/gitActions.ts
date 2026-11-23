import * as vscode from 'vscode';
import type { WorksetActions } from './actions.ts';
import { branchWorksetName, commitFromArg, commitPickerMatches, CONFIRM_ABOVE, historyItemCommits, type HistoryItemRef } from './core/git.ts';
import { formatRelativeTime, type Workset } from './core/model.ts';
import type { ChangeSet, GitRepository, GitService } from './git.ts';
import type { WorksetStore } from './store.ts';

const STAT_CONCURRENCY = 32;

/** The repository root from a graph menu argument: a SourceControl (`rootUri`), live or as plain data. */
function rootUriOf(value: unknown): vscode.Uri | undefined {
	let rootUri = (value as { rootUri?: unknown } | undefined)?.rootUri;
	if (rootUri instanceof vscode.Uri) {
		return rootUri;
	}
	let parts = rootUri as { scheme?: unknown; path?: unknown } | undefined;
	return typeof parts?.scheme === 'string' && typeof parts.path === 'string'
		? vscode.Uri.from({ scheme: parts.scheme, path: parts.path })
		: undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** Resource URIs from Source Control menu arguments: resource states, or groups of them. */
export function scmUris(args: readonly unknown[]): vscode.Uri[] {
	let uris = new Map<string, vscode.Uri>();
	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
		} else if (typeof value === 'object' && value !== null) {
			let { resourceUri, resourceStates } = value as { resourceUri?: unknown; resourceStates?: unknown };
			if (resourceUri instanceof vscode.Uri) {
				uris.set(resourceUri.toString(), resourceUri);
			} else if (Array.isArray(resourceStates)) {
				visit(resourceStates);
			}
		}
	};
	args.forEach(visit);
	return [...uris.values()];
}

/** Adding files from Git: the current branch, a commit, or Source Control and Timeline items. */
export class GitActions {
	private readonly git: GitService;
	private readonly actions: WorksetActions;
	private readonly store: WorksetStore;

	constructor(git: GitService, actions: WorksetActions, store: WorksetStore) {
		this.git = git;
		this.actions = actions;
		this.store = store;
	}

	async addBranchFiles(): Promise<void> {
		if (!this.actions.requireWorkspace()) {
			return;
		}
		let repo = await this.git.chooseRepository();
		let changes = repo && (await this.git.branchChanges(repo));
		if (!changes) {
			return;
		}
		// Named after the branch, if that name is free: a workset created for this, or an unnamed empty one.
		let newName = branchWorksetName(changes.label, this.store.all.map((w) => w.name));
		let active = this.store.active;
		let rename = active && !active.name && active.entries.length === 0 && newName ? active.id : undefined;
		await this.add(changes, newName);
		if (rename && (this.store.get(rename)?.entries.length ?? 0) > 0) {
			this.store.rename(rename, newName);
		}
	}

	/** Adds the files of a commit: `ref` if given (hash, tag, Timeline item), otherwise picked. */
	async addCommitFiles(ref?: unknown, uri?: unknown): Promise<void> {
		if (!this.actions.requireWorkspace()) {
			return;
		}
		let fromUri = uri instanceof vscode.Uri ? this.git.repositoryFor(uri) : undefined;
		let repo = fromUri ?? (await this.git.chooseRepository());
		if (!repo) {
			return;
		}
		let commit = commitFromArg(ref) ?? (await this.pickCommit(repo));
		let changes = commit && (await this.git.commitChanges(repo, commit));
		if (changes) {
			await this.add(changes);
		}
	}

	/**
	 * Right-click on commits in the Source Control graph. Arguments are the repository (a SourceControl,
	 * possibly only as plain data) and the selected history items.
	 */
	async addHistoryItems(...args: unknown[]): Promise<void> {
		let rootUri = args.map(rootUriOf).find((uri) => uri !== undefined);
		await this.addCommits(
			historyItemCommits(args).map((commit) => ({ commit, ...(rootUri ? { rootPath: rootUri.fsPath } : {}) })),
		);
	}

	/** Adds the files of commits dragged from the graph or right-clicked there, to `target` or the active workset. */
	async addCommits(refs: readonly HistoryItemRef[], target?: Workset): Promise<void> {
		if (refs.length === 0 || !this.actions.requireWorkspace()) {
			return;
		}
		let rootPath = refs.find((ref) => ref.rootPath)?.rootPath;
		let repo = (rootPath && this.git.repositoryFor(vscode.Uri.file(rootPath))) || (await this.git.chooseRepository());
		if (!repo) {
			return;
		}
		let uris = new Map<string, vscode.Uri>();
		let labels: string[] = [];
		for (let { commit } of refs) {
			let changes = await this.git.commitChanges(repo, commit);
			for (let changed of changes?.uris ?? []) {
				uris.set(changed.toString(), changed);
			}
			if (changes) {
				labels.push(changes.label);
			}
		}
		if (uris.size) {
			let label = labels.length <= 3 ? labels.join(', ') : `${labels.length} commits`;
			await this.add({ uris: [...uris.values()], label }, undefined, target);
		}
	}

	/** "Add to Active Workset" on files or change groups in the Source Control view. */
	async addScmResources(...args: unknown[]): Promise<void> {
		let uris = scmUris(args);
		let { existing, missing } = await this.partition(uris);
		if (existing.length === 0) {
			if (missing) {
				void vscode.window.showInformationMessage('File Worksets: The selected files were deleted, so there is nothing to add.');
			}
			return;
		}
		await this.actions.addUris(existing, undefined, { notFound: missing });
	}

	private async add(changes: ChangeSet, newName?: string, target?: Workset): Promise<void> {
		let { existing, missing } = await this.partition(changes.uris);
		if (existing.length === 0) {
			void vscode.window.showInformationMessage(`File Worksets: None of the files from ${changes.label} exist anymore.`);
			return;
		}
		if (existing.length > CONFIRM_ABOVE) {
			let choice = await vscode.window.showWarningMessage(
				`Add ${existing.length} files from ${changes.label}?`,
				{ modal: true },
				'Add',
			);
			if (choice !== 'Add') {
				return;
			}
		}
		await this.actions.addUris(existing, target, { from: changes.label, newName, notFound: missing });
	}

	private async partition(uris: readonly vscode.Uri[]): Promise<{ existing: vscode.Uri[]; missing: number }> {
		let existing: vscode.Uri[] = [];
		for (let start = 0; start < uris.length; start += STAT_CONCURRENCY) {
			let batch = uris.slice(start, start + STAT_CONCURRENCY);
			let found = await Promise.all(batch.map(exists));
			existing.push(...batch.filter((_, index) => found[index]));
		}
		return { existing, missing: uris.length - existing.length };
	}

	private async pickCommit(repo: GitRepository): Promise<string | undefined> {
		type Item = vscode.QuickPickItem & { ref: string };
		let quickPick = vscode.window.createQuickPick<Item>();
		quickPick.placeholder = 'Select a commit, or type or paste a hash, tag or other ref';
		quickPick.matchOnDescription = true;
		quickPick.busy = true;
		let items: Item[] = [];
		let update = (): void => {
			let typed = quickPick.value.trim();
			let { hashMatches, offerRef } = commitPickerMatches(
				typed,
				items.map((item) => item.ref),
			);
			// The picker's own filter only sees short hashes, so matches of a longer hash are forced visible.
			let matched = items.filter((item) => hashMatches.includes(item.ref)).map((item) => ({ ...item, alwaysShow: true }));
			let rest = items.filter((item) => !hashMatches.includes(item.ref));
			let use: Item[] = offerRef ? [{ label: `Use "${typed}"`, description: 'hash, tag or other ref', ref: typed, alwaysShow: true }] : [];
			quickPick.items = [...matched, ...rest, ...use];
		};
		// Registered before loading, so text typed or pasted meanwhile is handled too.
		quickPick.onDidChangeValue(update);
		let result = new Promise<string | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				let [selected] = quickPick.selectedItems;
				if (!selected) {
					return;
				}
				resolve(selected.ref);
				quickPick.hide();
			});
			quickPick.onDidHide(() => {
				resolve(undefined);
				quickPick.dispose();
			});
		});
		quickPick.show();
		let commits = await this.git.recentCommits(repo);
		let head = repo.state.HEAD?.commit;
		items = commits.map((commit) => ({
			label: commit.message.split('\n')[0] ?? commit.hash,
			description: `${commit.hash.slice(0, 7)}${commit.hash === head ? ' · current' : ''}`,
			detail: [commit.authorName, commit.authorDate && formatRelativeTime(commit.authorDate.toISOString())]
				.filter(Boolean)
				.join(', '),
			ref: commit.hash,
		}));
		update();
		quickPick.busy = false;
		return result;
	}
}
