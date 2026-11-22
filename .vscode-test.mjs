import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests write .vscode/file-worksets.json and create/delete files, so run against a throwaway copy.
let workspace = mkdtempSync(join(tmpdir(), 'file-worksets-'));
cpSync('test/fixtures/workspace', workspace, { recursive: true });
process.on('exit', () => rmSync(workspace, { recursive: true, force: true }));

export default defineConfig({
	files: 'out/integration/**/*.test.cjs',
	workspaceFolder: workspace,
	launchArgs: ['--disable-extensions'],
	mocha: { ui: 'tdd', timeout: 20000 },
});
