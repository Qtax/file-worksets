import * as vscode from 'vscode';
import { relativeUriPath } from './core/paths.ts';

export interface Location {
	readonly root: string | undefined;
	readonly path: string;
}

let ignoreCase = process.platform === 'win32' || process.platform === 'darwin';

/** Maps between URIs and the `(root, path)` references stored in worksets. */
export class WorkspaceRoots {
	folders(): readonly vscode.WorkspaceFolder[] {
		return vscode.workspace.workspaceFolders ?? [];
	}

	isMultiRoot(): boolean {
		return this.folders().length > 1;
	}

	/** Entries without an explicit root belong to the first workspace folder. */
	defaultRoot(): string | undefined {
		return this.folders()[0]?.name;
	}

	/**
	 * Folder names identify roots. A name shared by several workspace folders is
	 * ambiguous and resolves to nothing rather than possibly the wrong folder.
	 */
	resolve(root: string | undefined): vscode.WorkspaceFolder | undefined {
		let folders = this.folders();
		if (root === undefined) {
			return folders[0];
		}
		let matches = folders.filter((folder) => folder.name === root);
		return matches.length === 1 ? matches[0] : undefined;
	}

	locate(uri: vscode.Uri): Location | undefined {
		let folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder || folder.uri.scheme !== uri.scheme || folder.uri.authority !== uri.authority) {
			return undefined;
		}
		let path = relativeUriPath(folder.uri.path, uri.path, ignoreCase && uri.scheme === 'file');
		if (path === undefined) {
			return undefined;
		}
		if (!this.isMultiRoot()) {
			return { root: undefined, path };
		}
		return this.resolve(folder.name)?.index === folder.index ? { root: folder.name, path } : undefined;
	}

	uriFor(root: string | undefined, path: string): vscode.Uri | undefined {
		let folder = this.resolve(root);
		return folder ? joinPath(folder.uri, path) : undefined;
	}

	/** Relative path as shown to users; prefixed by the folder name in multi-root workspaces. */
	displayPath(root: string | undefined, path: string): string {
		if (!this.isMultiRoot()) {
			return path;
		}
		let name = root ?? this.defaultRoot() ?? '';
		return path ? `${name}/${path}` : name;
	}
}

export function joinPath(base: vscode.Uri, relativePath: string): vscode.Uri {
	return relativePath ? vscode.Uri.joinPath(base, ...relativePath.split('/')) : base;
}
