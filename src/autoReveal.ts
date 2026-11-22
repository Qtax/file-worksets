import * as vscode from 'vscode';
import { tabUri } from './actions.ts';
import { compileExcludes } from './core/glob.ts';
import { isFileNode } from './fileTree.ts';
import type { FileNode } from './fileTree.ts';
import type { WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';
import type { ActiveFilesProvider, ActiveNode } from './views.ts';

/**
 * Selects the active editor's file in Workset Files, like the Explorer does.
 * Follows the Explorer's own settings: `explorer.autoReveal` and `explorer.autoRevealExclude`.
 */
export class ActiveEditorRevealer implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private requests = 0;
	private readonly view: vscode.TreeView<ActiveNode>;
	private readonly provider: ActiveFilesProvider;
	private readonly roots: WorkspaceRoots;

	constructor(view: vscode.TreeView<ActiveNode>, provider: ActiveFilesProvider, store: WorksetStore, roots: WorkspaceRoots) {
		this.view = view;
		this.provider = provider;
		this.roots = roots;
		let schedule = (): void => this.schedule();
		this.disposables = [
			vscode.window.tabGroups.onDidChangeTabs(schedule),
			vscode.window.tabGroups.onDidChangeTabGroups(schedule),
			view.onDidChangeVisibility(schedule),
			// Re-reveal after switching worksets or when the active file was just added.
			store.onDidChange(schedule),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('explorer.autoReveal') ||
					event.affectsConfiguration('explorer.autoRevealExclude')
				) {
					schedule();
				}
			}),
		];
	}

	/** Reveals the active editor's file now. Resolves to the revealed item, if any. */
	async revealActiveEditor(): Promise<FileNode | undefined> {
		// A newer request (editor switch, workset change, ...) supersedes this one, even mid-lookup.
		let request = ++this.requests;
		let uri = tabUri(vscode.window.tabGroups.activeTabGroup.activeTab);
		if (!uri || !this.view.visible) {
			return undefined;
		}
		// The explorer.* settings are window-scoped, so they're read without a resource.
		let explorer = vscode.workspace.getConfiguration('explorer');
		// `focusNoScroll` is treated like `true`: the tree view API can't select without scrolling.
		if (explorer.get<boolean | string>('autoReveal', true) === false) {
			return undefined;
		}
		let location = this.roots.locate(uri);
		if (!location || this.isExcluded(location.path, explorer.get<Record<string, unknown>>('autoRevealExclude'))) {
			return undefined;
		}
		let node = await this.provider.findNode(location);
		if (!node || request !== this.requests) {
			return undefined;
		}
		let [selected, ...rest] = this.view.selection;
		if (rest.length === 0 && isFileNode(selected) && selected.path === node.path && selected.root === node.root) {
			return node;
		}
		try {
			await this.view.reveal(node, { select: true, focus: false, expand: false });
			return node;
		} catch {
			// The tree changed while revealing; the next event will try again.
			return undefined;
		}
	}

	/** Like the Explorer, a file is excluded if it or any of its parent folders matches a pattern. */
	private isExcluded(path: string, config: Record<string, unknown> | undefined): boolean {
		let patterns = compileExcludes(config);
		if (patterns.length === 0) {
			return false;
		}
		let segments = path.split('/');
		return segments.some((_, i) => {
			let prefix = segments.slice(0, i + 1).join('/');
			return patterns.some((pattern) => pattern.test(prefix));
		});
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.revealActiveEditor(), 100);
	}

	dispose(): void {
		clearTimeout(this.timer);
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
