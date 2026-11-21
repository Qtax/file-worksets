# File Worksets — features and roadmap

## Implemented

### Views

- **Own activity bar container, "File Worksets"**, with two views. Both can be dragged into the Explorer container or anywhere else, like any built-in view.
- **Workset Files**
  - Shows only the active workset's files, grouped by workspace-relative folder path. Folders appear only if they lead to a selected file. Siblings on disk are never listed.
  - Looks like the Explorer:
    - File icon theme.
    - Compact folders (`src \ lib \ deep`, using the OS path separator and thin spaces like the Explorer's margins), following `explorer.compactFolders`. This also applies to subfolder chains inside folders added as a whole.
    - The Explorer's sort settings: `explorer.sortOrder` (`default`, `mixed`, `filesFirst`, `type`; `modified` and `foldersNestsFiles` fall back to `default`) and `explorer.sortOrderLexicographicOptions`.
  - Remaining differences from the Explorer, all due to API limits:
    - The separator in compact folder names isn't dimmed. Extension tree labels are plain text.
    - The parts of a compact folder name can't be selected or targeted individually.
    - No inline rename.
    - No file nesting (`explorer.fileNesting`) and no `explorer.excludeGitIgnore`.
  - Clicking a file opens it (preview mode follows your editor settings). Clicking a folder expands or collapses it. Collapse All is available.
  - Git and problem decorations appear on files, the same as in the Explorer.
  - **Follows the active editor.** The open file is selected and revealed, using the Explorer's own settings:
    - `explorer.autoReveal` turns it on or off. `focusNoScroll` behaves like on, because the tree view API can't select without scrolling.
    - `explorer.autoRevealExclude` skips files under excluded folders, `node_modules` by default.
    - Files included through a folder entry are revealed too. Files that aren't in the workset leave the selection unchanged.
  - The view title is the active workset's name. When it's the only visible view in the sidebar, the header reads "File Worksets: NAME - Multi-select is supported.
  - Multi-root workspaces show one top-level node per workspace folder that has entries.
- **File Worksets** (the list of worksets; when it's the only visible view, the header is just "File Worksets")
  - Lists all saved worksets. The active one has a filled check icon, a highlighted name, and an "active" description.
  - Each item shows its file and folder counts. The tooltip shows when it was created and last used.
  - Clicking an inactive workset activates it. Expanding any workset browses its files without activating it.
  - Sort by creation date (default, newest first), last used, or name using the title-bar **Sort** button (`fileWorksets.sortOrder`).
- **Status bar item** showing the active workset. Clicking it opens Switch/New Workset. Turn it off with `fileWorksets.showStatusBarItem`.
- **Explorer marks for the active workset.** Names of files and folders in the active workset are tinted with a themeable color, `fileWorksets.worksetFileForeground`. It defaults to the keyword purple of the default themes mixed 30% toward the default text color (`#C79BC4` in Dark+, `#981DB6` in Light+), so it reads as a light tint of normal text. High contrast themes use their `charts.purple`. Extension colors can't be computed from the theme at runtime, so these are fixed values per theme type. Override it with `workbench.colorCustomizations`. Their parent folders get VS Code's small "contains" dot, like Git's.
  - For folders added as a whole, only the folder itself is marked.
  - The tooltip names the workset.
  - `fileWorksets.explorerDecoration` switches between `color` (default; least crowded next to Git's letters), `badge`, `both`, and `off`.
  - The badge text is set with `fileWorksets.explorerDecorationBadge`: ★ by default, at most 2 characters. VS Code only allows text badges, not icons.
  - On files that Git also colors (modified, untracked, …), Git's color may take precedence.
  - VS Code applies file decorations everywhere a file is shown, so the badge also appears in editor tabs, Open Editors, and on the items in Workset Files. An extension can't limit it to the Explorer without also losing Git's decorations in its own views.
- **Welcome content** for the cases where no folder is open, no workset is active, or the workset is empty. It's only shown once the worksets have loaded. While VS Code starts up, the views show VS Code's thin progress bar instead of briefly flashing an empty state.

### Managing worksets

- Create, rename, duplicate, and delete worksets. Deleting happens right away, without a confirmation dialog. A notification ("Deleted workset "…".") offers **Undo**, which brings the worksets back with the same ID, name, creation time, files, and last-used time, and makes the active one active again. If its name was taken in the meantime, the restored workset becomes unnamed.
- **New worksets have no name.** They're shown by their creation time ("2026-11-20 23:51") until you rename them. Renaming is easy from several places:
  - The pencil button on the row.
  - <kbd>F2</kbd> in the File Worksets list.
  - The right-click menu.
  - The Workset Files "…" menu.
  - The rename button in Switch/New Workset.
  Clearing the name makes the workset unnamed again. Names must be unique, ignoring case.
- <kbd>Delete</kbd> (<kbd>Cmd+Backspace</kbd> on macOS) on selected worksets in the File Worksets list deletes them, with Undo in the notification. With several worksets selected, all of them are deleted at once, from the key or the context menu. **Delete Workset…** in the Command Palette opens a multi-select picker.
- **Switch/New Workset…** (palette, status bar, Workset Files toolbar) opens a Quick Pick in the same order as the File Worksets list (`fileWorksets.sortOrder`). The active workset is highlighted when it opens (or **No Active Workset** if none is active), so you see where you are. The Quick Pick also has inline rename and delete buttons and a **New Workset** entry. The other workset pickers (Add to Workset…, Copy/Move to Workset…, Delete Workset…) use the same order.
- Switching only updates the sidebar. It never opens or closes tabs, changes Git state, or modifies files. It doesn't write to the storage either.
- **No active workset** is a valid state for working without a workset in mind. Nothing is auto-added and Workset Files is empty; deleting files in VS Code still removes them from any workset that contains them. You can get there in four ways:
  - **Deactivate Workset** in the Command Palette.
  - The ⊘ button on the active row in the File Worksets list, or its context menu.
  - The Workset Files "…" menu.
  - **No Active Workset** in Switch/New Workset.
- Explicitly adding files (menu, toolbar, drag and drop) while no workset is active creates a new unnamed workset and activates it.

### Adding and removing

- **Explorer context menu:** **Add to Active Workset** and **Add to Workset…** work on single or multi-selections of files and folders.
- **Editor tab context menu:** the same two commands.
- **Workset Files toolbar:** **Add Active Editor** (works for text, custom, notebook, and diff editors), **Add All Open Editors**, and **Remove Active Editor**.
- If no workset is active, a new unnamed workset is created and activated, without asking.
- Adding something that's already included is a no-op, including a file inside an already-added folder. A short status bar message reports what was added.
- A file can belong to any number of worksets.
- **Folder entries** include everything in the folder. The contents come from disk when you expand the folder, so new and deleted files show up automatically. Entries matching `files.exclude` are hidden. Folder entries are labeled "entire folder".
- **Remove from Workset** (inline ✕ button or context menu) removes only the reference. Removing an implicit folder or a workspace-root node removes all entries under it, without asking. Files that are shown only because their parent folder was added can't be removed individually; you'll be told which folder includes them.
- **Remove Missing Files from Workset** cleans up references whose files no longer exist.

### Auto-add

- The `fileWorksets.autoAdd` setting adds files to the active workset automatically:
  - **Off.**
  - **Opened Files:** files opened in a regular tab. Single-click previews (italic tabs) aren't added until they become regular tabs, for example by double-clicking or editing.
  - **Edited Files** (default): files you type in. Only changes in the active editor count, so Replace All across files and rename refactorings don't add files.
- A button in the **Workset Files** title bar shows the current mode as an icon (⊘ off, eye for opened, pencil for edited). Clicking it opens a picker. **Set Auto-Add Mode…** in the Command Palette does the same.
- The button writes to user settings, unless the setting is already defined at workspace level, so it doesn't modify the repo's `.vscode/settings.json`.
- Nothing is added while no workset is active, and you're never prompted. The storage file `.vscode/file-worksets.json` itself is never added.
- A removed file comes back if you open or edit it again while auto-add is on.

### Drag and drop

- From the Explorer or editor tabs onto **Workset Files**: adds the items to the active workset.
- From the Explorer onto a workset in **File Worksets**: adds the items to that workset.
- From **Workset Files** or another workset onto a workset: copies the items. Dropping an implicit folder copies all entries under it.
- Dragging a whole workset onto another workset, or onto Workset Files, merges its entries.
- Dropping onto empty space in **File Worksets** creates a new workset from the dropped items.
- Dragging files out of either view into the editor area opens them.
- **Copy to Workset…** and **Move to Workset…** context menu commands handle explicit copy and move.
- Dropping items onto the workset they came from, or adding only items that are already in the workset, shows "Already in "WORKSET". Nothing changed." in the status bar. VS Code doesn't let extensions show a "not allowed" cursor or suppress the drop highlight for a specific target.

### Explorer-style context menu

VS Code doesn't let extensions reuse the Explorer's own context menu in their views, so the file items in both views get a copy of it. Entries use the same groups and order as the Explorer, and built-in commands are called with the item's URI:

- **Folders:** New File… and New Folder… (nested paths like `a/b.ts` work; the new item is added to the workset and new files open), Find in Folder…
- **Files:** Open to the Side, Open With…, Select for Compare, Compare with Selected, Compare Selected (when two files are selected).
- **Both:** Reveal in File Explorer / Reveal in Finder / Open Containing Folder, Open in Integrated Terminal, Reveal in Explorer View, Copy Path, Copy Relative Path.
- **Rename…** renames on disk through a `WorkspaceEdit`, so other extensions' rename handlers (such as import updates) run. References in all worksets follow.
- **Delete** asks for confirmation and moves the item to the Recycle Bin/Trash (honors `files.enableTrash`). Like any delete done in VS Code, it removes the references from all worksets (see below).
- Workset items at the end: Remove from Workset, Copy to Workset…, Move to Workset….
- **Keyboard shortcuts** in both views, the same as the Explorer's: <kbd>F2</kbd> Rename, <kbd>Ctrl+Enter</kbd> Open to the Side, Copy Path, Copy Relative Path, and Reveal in OS.
  - Rename is <kbd>F2</kbd> on Windows/Linux and <kbd>Enter</kbd> on macOS, the Explorer's defaults. On macOS, <kbd>Cmd+Down</kbd> opens the item, as in the Explorer.
  - On a workset row in the File Worksets list, the rename key renames the workset.
  - VS Code doesn't let extensions read your keybindings, so if you've rebound the Explorer's rename, rebind **File Worksets: Rename…** too.
  - Renaming uses an input box at the top of the window. VS Code has no API for inline editing in extension tree views.
  - <kbd>Delete</kbd> (<kbd>Cmd+Backspace</kbd> on macOS) is **Remove from Workset** for files and folders, not delete from disk. On a workset row in the File Worksets list, it deletes the workset.
- Not included:
  - Cut/Copy/Paste use the Explorer's internal clipboard.
  - Items contributed by other extensions (Git, Timeline, etc.) only appear in the real Explorer.

### Persistence

- Workset definitions are saved automatically. Where they go depends on `fileWorksets.storageLocation`:
  - **`workspaceState` (default):** VS Code's per-workspace extension storage. It's keyed by the workspace (folder or `.code-workspace` file) and kept separately by each editor (VS Code, Insiders, Cursor, …). Worksets never collide across repos, workspaces, or editors, and nothing is written to the repository. If a `.vscode/file-worksets.json` already exists, it's read until the first change is saved, so existing worksets aren't lost.
  - **`workspaceFolder`:** `.vscode/file-worksets.json` in the first workspace folder, for example to commit and share worksets. The `.vscode` folder is created only when the first workset is saved.
- In repo-file mode, the file is meant to be easy to review and edit by hand:
  - Paths are workspace-relative and always use `/`, including on Windows.
  - Paths are sorted, so diffs stay small.
  - Files and folders are stored in separate lists.
  - Multi-root entries are stored as `{ "root": "<folder name>", "path": "…" }`.
- The active workset and last-used times live in VS Code's workspace state, so switching never changes the repo.
- External changes to the file (manual edits, `git checkout`, `git pull`) are reloaded live. If the file can't be parsed, a warning is shown and saving pauses until it's fixed, so your edits aren't overwritten.
- Changing `fileWorksets.storageLocation` copies your worksets to the new location if it's empty. Otherwise the worksets already stored there are loaded.
- Loaded data is validated. Absolute paths, drive letters, and `.`/`..` segments are rejected, so a committed file can't point outside the workspace.

### Missing, deleted and renamed files

- **Deleted in VS Code** (Explorer, Delete commands, refactorings, anything using `onDidDeleteFiles`): the file or folder is removed from **all** worksets automatically. A status bar message says how many items were removed.
- **Restored within 24 hours:** if a deleted path reappears on disk, for example through `git restore`, Discard Changes, or undoing the delete, it's added back to the worksets it was removed from. Pending restores are kept in workspace state, so they survive a reload.
- **Gone from disk for other reasons** (switching git branches, `git checkout`, deleting from a terminal or another app): references are **kept**. They're greyed out with a `!` badge and labeled "missing", and they return to normal when the file reappears. VS Code only fires `onDidDeleteFiles` for its own deletes, which is what makes this distinction possible.
- Renaming or moving files and folders through VS Code (Explorer, refactorings) updates the references in all worksets.
- The views refresh automatically, debounced, when files are created or deleted at or under a referenced path.

### Engineering

- TypeScript (TS 7, strict, `noUncheckedIndexedAccess`), bundled by esbuild into a single CommonJS file. There are no runtime dependencies.
- Code style: tabs for indentation and spaces only for alignment (`.editorconfig`). `let` is used for all bindings; `const` only for top-level UPPER_CASE constants. ESLint enforces both, using `eslint-plugin-prefer-let` with `forceUpperCaseConst`, `@stylistic/indent` set to tabs, and `no-mixed-spaces-and-tabs` set to smart-tabs.
- ESLint uses typescript-eslint, which doesn't support TS 7 yet because TS 7 has no JavaScript API. Two workarounds cover this:
  - `eslint.config.mjs` registers a Node resolve hook that maps `typescript` to `@typescript/typescript6` for ESLint only.
  - An npm `overrides` entry satisfies the peer-dependency range.
  - Remove both once typescript-eslint supports TS 7.
- The pure logic in `src/core/` (paths, model, serialization, tree, glob) has no `vscode` import. It's covered by `node:test` unit tests that run the `.ts` files directly on Node 26.
- Integration tests use `@vscode/test-cli` and run in a real VS Code against a temporary copy of a fixture workspace. They cover adding, no-op re-adds, tree shape, folder entries, persistence, external reloads (including restoring older content), switching without side effects, removal, renames, missing files, and drag-and-drop through the real drag-data serialization.
- Drag and drop between the views carries workset references as a JSON string in a custom MIME type. Tree element objects aren't passed between views, so this is what works. The data is validated when dropped.
- Saves are queued. Reloads wait for pending writes and drop reads that raced with local edits or a storage switch. A failed write is retried on the next change.

## Next / left to do

### Likely next

- [ ] **Exclusions inside folder entries.** Let users remove individual files from a folder entry by storing an `excludes` list on the folder entry.
- [ ] **Undo for reference removals.** Deleting worksets can be undone. Removing files or folders from a workset can't yet; a similar notification could offer Undo there too.
- [ ] **Move semantics for drag and drop.** Drag-and-drop between worksets currently always copies, because the tree DnD API doesn't expose modifier keys. Move is available from the context menu. Possibly add a setting for the default.
- [ ] **More keyboard shortcuts.** The Explorer-equivalent shortcuts inside the views are done. Global ones for Switch/New Workset and "add active editor" are still missing, to avoid conflicts.
- [ ] **Explorer parity gaps.**
  - Cut/Copy/Paste of files.
  - New File/New Folder in the view title bar.
  - Inline rename in the tree. VS Code has no API for it, not even a proposed one; renaming uses an input box.
- [ ] **Filter/find in Workset Files.** The built-in tree find widget works. A filter for workset names in the File Worksets view would help when there are many worksets.

### Automation ideas

- [ ] Create a workset from the files changed on the current branch or in the working tree (Git extension API).
- [ ] Create a workset from search results, the files in a commit or PR, or Problems.
- [ ] Auto-add ignore list (globs such as `**/*.lock` or generated files), or limiting auto-add to files under certain folders.
- [ ] Suggest related files, for example a test next to its source (`foo.ts` ↔ `foo.test.ts`).
- [ ] Optionally restore a workset's editors on switch. This would be opt-in, since switching must have no side effects by default.

### Robustness and polish

- [ ] **Multi-root edge cases.**
  - Entries whose workspace folder isn't open are kept but hidden. Show them as missing under a placeholder root instead.
  - Roots are identified by folder name. If several workspace folders share a name, they're treated as ambiguous: their entries are hidden and adding from them is skipped. A unique root ID would fix this.
  - Storage always uses the first folder. Consider storing next to the `.code-workspace` file instead.
- [ ] **Case-only renames on Windows and macOS.** Duplicate detection is case-sensitive.
- [ ] **Files outside the workspace** are currently rejected. They could be supported with absolute URIs, stored only in workspace state.
- [ ] **Merge on storage-location change.** Today it either migrates into an empty location or loads the target.
- [ ] **Large folder entries.** Consider lazy paging and a respect-`.gitignore` option, similar to `explorer.excludeGitIgnore`.
- [ ] **Custom ordering** of worksets in the Worksets view, using drag to reorder.
- [ ] **Import/export** a workset as a plain list of paths, for example to share in a PR description.
- [ ] **Publishing.**
  - Replace the placeholder `publisher` (`local`) and add a license, icon, and screenshots.
  - Add CI (typecheck, unit, and integration tests) and Marketplace publishing.
