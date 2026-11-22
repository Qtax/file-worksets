import * as vscode from 'vscode';
import { relativeUriPath } from './core/paths.ts';

export interface Location {
	readonly root: string | undefined;
	readonly path: string;
}

let ignoreCase = process.platform === 'win32' || process.platform === 'darwin';
const ROOTLESS_FOLDER_KEY = 'fileWorksets.rootlessFolder';

/**
 * Maps between URIs and the `(root, path)` references stored in worksets.
 *
 * In a single-folder workspace, references are stored without a root. Which folder those belong to
 * is remembered, so that when folders are added or removed later they're pinned to that folder
 * (see `rootlessOwner`) instead of silently following whichever folder happens to be first.
 */
export class WorkspaceRoots {
	private readonly memento: vscode.Memento | undefined;
	/** Memento key remembering the rootless folder for the current storage source. */
	private ownerKey = ROOTLESS_FOLDER_KEY;
	/** For a storage file: the folder holding it, which its rootless entries belong to by default. */
	private sourceFolder: string | undefined;

	constructor(memento?: vscode.Memento) {
		this.memento = memento;
	}

	/**
	 * Call before loading a storage source. Ownership of rootless entries is remembered per source, so a
	 * different repo's storage file isn't pinned to the folder remembered for another one.
	 */
	useSource(source: { readonly file: vscode.Uri; readonly folder: string } | undefined): void {
		this.ownerKey = source ? `${ROOTLESS_FOLDER_KEY}:${source.file.toString()}` : ROOTLESS_FOLDER_KEY;
		this.sourceFolder = source?.folder;
	}

	private rememberedOwner(): string | undefined {
		return this.memento?.get<string>(this.ownerKey) ?? this.sourceFolder;
	}

	folders(): readonly vscode.WorkspaceFolder[] {
		return vscode.workspace.workspaceFolders ?? [];
	}

	isMultiRoot(): boolean {
		return this.folders().length > 1;
	}

	/** The folder that entries without an explicit root belong to. */
	defaultRoot(): string | undefined {
		let folders = this.folders();
		if (folders.length > 1) {
			return this.rememberedOwner() ?? folders[0]?.name;
		}
		return folders[0]?.name;
	}

	/**
	 * Call when the workspace folders are known or have changed. Returns the folder name that existing
	 * rootless entries must be pinned to (they no longer belong to the current default folder), if any.
	 */
	rootlessOwner(): string | undefined {
		let folders = this.folders();
		let remembered = this.rememberedOwner();
		let [first] = folders;
		if (!first) {
			return undefined;
		}
		if (folders.length === 1) {
			void this.memento?.update(this.ownerKey, first.name);
			return remembered !== undefined && remembered !== first.name ? remembered : undefined;
		}
		let owner = remembered ?? first.name;
		void this.memento?.update(this.ownerKey, owner);
		return owner;
	}

	/**
	 * Folder names identify roots. A name shared by several workspace folders is
	 * ambiguous and resolves to nothing rather than possibly the wrong folder.
	 */
	resolve(root: string | undefined): vscode.WorkspaceFolder | undefined {
		let folders = this.folders();
		if (root === undefined) {
			if (folders.length <= 1) {
				return folders[0];
			}
			root = this.defaultRoot();
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
