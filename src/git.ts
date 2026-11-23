import * as vscode from 'vscode';
import { changedFiles, detectBaseBranch, EMPTY_TREE } from './core/git.ts';
import type { WorksetGit } from './core/model.ts';

// The subset of VS Code's Git extension API (extensions/git/src/api/git.d.ts, API version 1) used here.
interface GitRef {
	readonly name?: string;
	readonly commit?: string;
}

interface GitChange {
	readonly uri: vscode.Uri;
	readonly renameUri: vscode.Uri | undefined;
	readonly status: number;
}

interface GitCommit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
	readonly authorDate?: Date;
	readonly authorName?: string;
}

export interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: {
		readonly HEAD: GitRef | undefined;
		readonly onDidChange: vscode.Event<void>;
	};
	getCommit(ref: string): Promise<GitCommit>;
	diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
	getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
	getRefs(query: { pattern?: string | string[] }): Promise<GitRef[]>;
	getBranches(query: { remote?: boolean }): Promise<GitRef[]>;
	log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}

interface GitApi {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
	readonly onDidCloseRepository: vscode.Event<GitRepository>;
	getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: vscode.Event<boolean>;
	getAPI(version: 1): GitApi;
}

const READY_TIMEOUT_MS = 10_000;
const BASE_BRANCH_KEY = 'fileWorksets.git.baseBranch';

export interface CommitPick {
	readonly hash: string;
	readonly message: string;
	readonly authorName?: string;
	readonly authorDate?: Date;
}

export interface ChangeSet {
	/** Files that exist after the changes (deletions dropped, renames mapped). */
	readonly uris: vscode.Uri[];
	/** How the changes are described in messages, e.g. `feature/login` or `1a2b3c4`. */
	readonly label: string;
}

/**
 * Read-only access to VS Code's Git extension. Git is optional: without it (or without a repository)
 * the Git commands are hidden via the `fileWorksets.hasGitRepo` context key.
 */
export class GitService implements vscode.Disposable {
	private api: GitApi | undefined;
	private ready: Promise<GitApi | undefined> | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly repoListeners = new Map<GitRepository, vscode.Disposable>();
	private readonly emitter = new vscode.EventEmitter<void>();
	/** Fires when repositories open or close, or a repository's branch changes. */
	readonly onDidChange = this.emitter.event;
	private readonly memento: vscode.Memento;
	private branches = new Map<GitRepository, string | undefined>();

	constructor(memento: vscode.Memento) {
		this.memento = memento;
	}

	/** The Git API once it's initialized, or undefined when Git is disabled or unavailable. */
	whenReady(): Promise<GitApi | undefined> {
		this.ready ??= this.connect();
		return this.ready;
	}

	private async connect(): Promise<GitApi | undefined> {
		let extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (!extension) {
			return undefined;
		}
		let exports: GitExtension;
		try {
			exports = extension.isActive ? extension.exports : await extension.activate();
		} catch {
			return undefined;
		}
		this.disposables.push(
			exports.onDidChangeEnablement((enabled) => {
				if (!enabled) {
					this.detach();
				}
				this.ready = undefined;
				void this.whenReady();
			}),
		);
		if (!exports.enabled) {
			return undefined;
		}
		let api = exports.getAPI(1);
		if (api.state !== 'initialized') {
			await new Promise<void>((resolve) => {
				let timer = setTimeout(resolve, READY_TIMEOUT_MS);
				let listener = api.onDidChangeState((state) => {
					if (state === 'initialized') {
						clearTimeout(timer);
						listener.dispose();
						resolve();
					}
				});
			});
		}
		this.attach(api);
		return api;
	}

	private attach(api: GitApi): void {
		this.api = api;
		this.disposables.push(
			api.onDidOpenRepository((repo) => this.watch(repo)),
			api.onDidCloseRepository((repo) => {
				this.repoListeners.get(repo)?.dispose();
				this.repoListeners.delete(repo);
				this.branches.delete(repo);
				this.changed();
			}),
		);
		for (let repo of api.repositories) {
			this.watch(repo);
		}
		this.changed();
	}

	private detach(): void {
		this.api = undefined;
		for (let listener of this.repoListeners.values()) {
			listener.dispose();
		}
		this.repoListeners.clear();
		this.branches.clear();
		this.changed();
	}

	private watch(repo: GitRepository): void {
		if (this.repoListeners.has(repo)) {
			return;
		}
		this.branches.set(repo, repo.state.HEAD?.name);
		this.repoListeners.set(
			repo,
			repo.state.onDidChange(() => {
				let branch = repo.state.HEAD?.name;
				if (branch !== this.branches.get(repo)) {
					this.branches.set(repo, branch);
					this.emitter.fire();
				}
			}),
		);
		this.changed();
	}

	private changed(): void {
		void vscode.commands.executeCommand('setContext', 'fileWorksets.hasGitRepo', (this.api?.repositories.length ?? 0) > 0);
		this.emitter.fire();
	}

	/**
	 * The repository to use without asking: the active editor's, the only one, or the one holding the
	 * first workspace folder. Undefined if Git isn't ready or there's no repository.
	 */
	defaultRepository(): GitRepository | undefined {
		let api = this.api;
		if (!api || api.repositories.length === 0) {
			return undefined;
		}
		let active = vscode.window.activeTextEditor?.document.uri;
		let fromEditor = active && api.getRepository(active);
		if (fromEditor) {
			return fromEditor;
		}
		if (api.repositories.length === 1) {
			return api.repositories[0];
		}
		let folder = vscode.workspace.workspaceFolders?.[0];
		return (folder && api.getRepository(folder.uri)) || api.repositories[0];
	}

	/** Like `defaultRepository`, but asks when several repositories exist and the editor doesn't decide. */
	async chooseRepository(): Promise<GitRepository | undefined> {
		let api = await this.whenReady();
		if (!api || api.repositories.length === 0) {
			void vscode.window.showInformationMessage('File Worksets: No Git repository found in this workspace.');
			return undefined;
		}
		let active = vscode.window.activeTextEditor?.document.uri;
		let fromEditor = active && api.getRepository(active);
		if (fromEditor || api.repositories.length === 1) {
			return fromEditor || api.repositories[0];
		}
		let picked = await vscode.window.showQuickPick(
			api.repositories.map((repo) => ({
				label: vscode.workspace.asRelativePath(repo.rootUri, true) || repo.rootUri.fsPath,
				description: repo.state.HEAD?.name ?? repo.state.HEAD?.commit?.slice(0, 7),
				repo,
			})),
			{ placeHolder: 'Select a Git repository' },
		);
		return picked?.repo;
	}

	repositoryFor(uri: vscode.Uri): GitRepository | undefined {
		return this.api?.getRepository(uri) ?? undefined;
	}

	/** Current branch of the default repository, for labels. */
	currentBranch(): string | undefined {
		return this.defaultRepository()?.state.HEAD?.name;
	}

	/** Where a new workset is being created; read synchronously, so only once Git is ready. */
	origin(rootName: (uri: vscode.Uri) => string | undefined): WorksetGit | undefined {
		let repo = this.defaultRepository();
		let head = repo?.state.HEAD;
		if (!repo || !head?.commit) {
			return undefined;
		}
		let root = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? rootName(repo.rootUri) : undefined;
		return { ...(head.name ? { branch: head.name } : {}), commit: head.commit, ...(root ? { root } : {}) };
	}

	/**
	 * Files committed on the current branch since it left its base branch. Undefined when cancelled
	 * or unavailable (a message has been shown).
	 */
	async branchChanges(repo: GitRepository): Promise<ChangeSet | undefined> {
		let branch = repo.state.HEAD?.name;
		if (!branch) {
			void vscode.window.showInformationMessage(
				'File Worksets: HEAD is detached, so there is no current branch. Use "Add Files from Commit…" instead.',
			);
			return undefined;
		}
		let base = await this.baseBranch(repo, branch);
		if (!base) {
			return undefined;
		}
		let mergeBase: string | undefined;
		try {
			mergeBase = await repo.getMergeBase('HEAD', base.ref);
		} catch {
			mergeBase = undefined;
		}
		if (!mergeBase) {
			void vscode.window.showWarningMessage(
				`File Worksets: Couldn't find where ${branch} left ${base.label}. In a shallow clone, fetch more history, or set "fileWorksets.git.baseBranch".`,
			);
			return undefined;
		}
		let changes = await repo.diffBetween(mergeBase, 'HEAD');
		let uris = changedFiles(changes);
		if (uris.length === 0) {
			void vscode.window.showInformationMessage(`File Worksets: No files committed on ${branch} since ${base.label}.`);
			return undefined;
		}
		return { uris, label: branch };
	}

	/** Files changed in a commit, compared with its first parent. */
	async commitChanges(repo: GitRepository, ref: string): Promise<ChangeSet | undefined> {
		let commit: GitCommit;
		try {
			commit = await repo.getCommit(ref);
		} catch {
			void vscode.window.showWarningMessage(`File Worksets: "${ref}" isn't a commit in this repository.`);
			return undefined;
		}
		let changes = await repo.diffBetween(commit.parents[0] ?? EMPTY_TREE, commit.hash);
		let uris = changedFiles(changes);
		let label = commit.hash.slice(0, 7);
		if (uris.length === 0) {
			void vscode.window.showInformationMessage(`File Worksets: Commit ${label} has no added or changed files.`);
			return undefined;
		}
		return { uris, label };
	}

	/** Recent commits for the commit picker, newest first. */
	async recentCommits(repo: GitRepository, count = 100): Promise<CommitPick[]> {
		try {
			return await repo.log({ maxEntries: count });
		} catch {
			return [];
		}
	}

	/**
	 * The base branch: the `fileWorksets.git.baseBranch` setting, one remembered for this repository,
	 * a detected one, or one picked by the user (then remembered).
	 */
	private async baseBranch(repo: GitRepository, current: string): Promise<{ ref: string; label: string } | undefined> {
		let configured = vscode.workspace.getConfiguration('fileWorksets').get<string>('git.baseBranch', '').trim();
		if (configured) {
			return { ref: configured, label: configured };
		}
		let rememberKey = `${BASE_BRANCH_KEY}:${repo.rootUri.toString()}`;
		let remembered = this.memento.get<string>(rememberKey);
		if (remembered && remembered !== current) {
			return { ref: remembered, label: remembered };
		}
		let refs = await repo.getRefs({}).catch((): GitRef[] => []);
		let names = refs.map((ref) => ref.name).filter((name): name is string => !!name);
		let detected = detectBaseBranch(names, current);
		if (detected) {
			return { ref: detected, label: detected === 'origin/HEAD' ? this.remoteDefaultName(refs) : detected };
		}
		let branches = await repo.getBranches({ remote: true }).catch((): GitRef[] => []);
		let picked = await vscode.window.showQuickPick(
			branches
				.map((ref) => ref.name)
				.filter((name): name is string => !!name && name !== current)
				.map((name) => ({ label: name })),
			{ placeHolder: `Which branch did ${current} start from? (remembered for this repository)` },
		);
		if (!picked) {
			return undefined;
		}
		await this.memento.update(rememberKey, picked.label);
		return { ref: picked.label, label: picked.label };
	}

	/** `origin/HEAD` shown as the branch it points to (the remote branch at the same commit). */
	private remoteDefaultName(refs: readonly GitRef[]): string {
		let head = refs.find((ref) => ref.name === 'origin/HEAD');
		let match = refs.find((ref) => ref.name !== 'origin/HEAD' && ref.name?.startsWith('origin/') && ref.commit === head?.commit);
		return match?.name ?? 'origin/HEAD';
	}

	dispose(): void {
		for (let listener of this.repoListeners.values()) {
			listener.dispose();
		}
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
		this.emitter.dispose();
	}
}
