import * as vscode from 'vscode';

export const STORAGE_FILE = '.vscode/file-worksets.json';
const MEMENTO_KEY = 'fileWorksets.worksets';

export interface StorageBackend extends vscode.Disposable {
	readonly description: string;
	read(): Promise<string | undefined>;
	write(content: string): Promise<void>;
	/** Fires when the stored data may have changed outside the extension (edits, git checkout). */
	readonly onDidChangeExternally: vscode.Event<void>;
}

export class FileStorageBackend implements StorageBackend {
	readonly description: string;
	readonly uri: vscode.Uri;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeExternally = this.emitter.event;
	private readonly watcher: vscode.FileSystemWatcher;

	constructor(folder: vscode.WorkspaceFolder) {
		this.uri = vscode.Uri.joinPath(folder.uri, ...STORAGE_FILE.split('/'));
		this.description = STORAGE_FILE;
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, STORAGE_FILE));
		let fire = (): void => this.emitter.fire();
		this.watcher.onDidCreate(fire);
		this.watcher.onDidChange(fire);
		this.watcher.onDidDelete(fire);
	}

	async read(): Promise<string | undefined> {
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri));
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return undefined;
			}
			throw error;
		}
	}

	async write(content: string): Promise<void> {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.uri, '..'));
		await vscode.workspace.fs.writeFile(this.uri, new TextEncoder().encode(content));
	}

	dispose(): void {
		this.watcher.dispose();
		this.emitter.dispose();
	}
}

/**
 * VS Code's per-workspace extension storage. It's keyed by workspace (folder or `.code-workspace`
 * file) and kept separately by each editor (VS Code, Insiders, Cursor, ...), so it never collides
 * across repos or editors and writes nothing to the repository.
 */
export class MementoStorageBackend implements StorageBackend {
	readonly description = 'workspace storage';
	readonly onDidChangeExternally: vscode.Event<void> = () => ({ dispose: () => undefined });
	private readonly memento: vscode.Memento;
	private readonly legacyFile: vscode.Uri | undefined;

	/** `legacyFile` is read instead while nothing has been stored yet, to pick up existing worksets. */
	constructor(memento: vscode.Memento, legacyFile?: vscode.Uri) {
		this.memento = memento;
		this.legacyFile = legacyFile;
	}

	async read(): Promise<string | undefined> {
		let stored = this.memento.get<string>(MEMENTO_KEY);
		if (stored !== undefined || !this.legacyFile) {
			return stored;
		}
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.legacyFile));
		} catch {
			return undefined;
		}
	}

	async write(content: string): Promise<void> {
		await this.memento.update(MEMENTO_KEY, content);
	}

	dispose(): void {}
}
