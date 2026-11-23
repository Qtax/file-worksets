# File Worksets

A focused, Explorer-like sidebar for the files that matter to the task at hand. Hand-pick files and folders from anywhere in the repo, save them as a named **workset**, and switch between worksets without touching your editors, branches, or files.

- **Workset Files** view: only the active workset's files, grouped by folder like the Explorer. Only folders that lead to a selected file are shown.
- **File Worksets** view: all saved worksets. Click one to activate it, or expand it to browse its files.
- **Switch/New Workset…** quick pick (also from the status bar) for keyboard navigation.
- Add files or whole folders from the Explorer context menu, the editor tab menu, drag and drop, or the Workset Files toolbar.
- Add the files committed on the current Git branch, or changed in a commit, and from the Source Control view. Each workset records the branch and commit it was created at.
- Files you edit are added to the active workset automatically. You can switch this to opened files or turn it off with `fileWorksets.autoAdd` or the toggle in the Workset Files title bar.

See [FEATURES.md](FEATURES.md) for the full feature list and what's planned next.

## Storage

By default worksets are saved in VS Code's per-workspace extension storage. Nothing is written to the repository, and each workspace and editor keeps its own worksets. To share worksets through the repository, set `fileWorksets.storageLocation` to `workspaceFolder`. They're then saved to `.vscode/file-worksets.json` as workspace-relative paths, which you can commit or add to `.gitignore`.

New worksets have no name and are shown by their creation time until you rename them (pencil button or <kbd>F2</kbd>). Adding a file while no workset is active creates one.

The active workset and last-used times are always kept in VS Code's per-workspace storage, so switching worksets never changes the file.

## Development

Requires Node 26 (`nvm use`).

```sh
npm install
npm run build          # bundle to dist/extension.cjs
npm run typecheck
npm run lint           # ESLint: tabs, `let` over `const`
npm run test:unit      # pure logic, runs TypeScript directly in Node
npm run test:integration   # runs inside a downloaded VS Code
npm test               # typecheck + lint + unit + integration
npm run package        # build a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

## Credits

The extension icon ([resources/worksets.svg](resources/worksets.svg)) is based on the `files` icon from [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). A star was added.
