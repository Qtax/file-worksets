import * as vscode from 'vscode';
import { worksetLabel } from './core/model.ts';
import { MISSING_QUERY } from './fileTree.ts';
import type { WorkspaceRoots } from './roots.ts';
import type { WorksetStore } from './store.ts';

export type DecorationStyle = 'badge' | 'color' | 'both' | 'off';

const DEFAULT_BADGE = '★';
const COLOR_ID = 'fileWorksets.worksetFileForeground';

function readStyle(): DecorationStyle {
	let value = vscode.workspace.getConfiguration('fileWorksets').get<string>('explorerDecoration', 'color');
	return value === 'badge' || value === 'both' || value === 'off' ? value : 'color';
}

/** VS Code rejects badges longer than 2 characters. */
function readBadge(): string {
	let value = vscode.workspace.getConfiguration('fileWorksets').get<string>('explorerDecorationBadge', DEFAULT_BADGE).trim();
	return value && value.length <= 2 ? value : DEFAULT_BADGE;
}

/**
 * Marks the active workset's files and folders wherever VS Code shows file decorations
 * (Explorer, tabs, Open Editors). Parent folders get VS Code's "contains" dot.
 * Contents of folders added as a whole are not marked individually, only the folder itself.
 */
export class WorksetFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.emitter.event;
	private marked = new Map<string, vscode.Uri>();
	private style = readStyle();
	private badge = readBadge();
	private readonly disposables: vscode.Disposable[];
	private readonly store: WorksetStore;
	private readonly roots: WorkspaceRoots;

	constructor(store: WorksetStore, roots: WorkspaceRoots) {
		this.store = store;
		this.roots = roots;
		this.disposables = [
			this.emitter,
			store.onDidChange(() => this.update()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('fileWorksets.explorerDecoration') ||
					event.affectsConfiguration('fileWorksets.explorerDecorationBadge')
				) {
					this.style = readStyle();
					this.badge = readBadge();
					this.update();
				}
			}),
		];
		this.update();
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		let active = this.store.active;
		if (this.style === 'off' || !active || uri.query === MISSING_QUERY || !this.marked.has(uri.toString())) {
			return undefined;
		}
		let decoration = new vscode.FileDecoration(
			this.style === 'color' ? undefined : this.badge,
			`In active workset "${worksetLabel(active)}"`,
			this.style === 'badge' ? undefined : new vscode.ThemeColor(COLOR_ID),
		);
		decoration.propagate = true;
		return decoration;
	}

	/** Recomputes the marked URIs. All old and new ones are refreshed, since the tooltip names the workset. */
	private update(): void {
		let next = new Map<string, vscode.Uri>();
		for (let entry of this.store.active?.entries ?? []) {
			let uri = this.roots.uriFor(entry.root, entry.path);
			if (uri) {
				next.set(uri.toString(), uri);
			}
		}
		let changed = new Map([...this.marked, ...next]);
		this.marked = next;
		if (changed.size) {
			this.emitter.fire([...changed.values()]);
		}
	}

	dispose(): void {
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
