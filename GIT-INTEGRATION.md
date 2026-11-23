# Git integration: design

Status: **implemented.** Remaining open point: the Timeline menu passes the Git extension's item to the command; that it carries the commit hash (`ref`/`id`) is handled defensively but only tested with a simulated item.

New ways to fill a workset from Git, and a record of where each workset was created.

1. **Add Files from Branch:** files committed on the current branch since it left its base branch.
2. **Add Files from Commit…:** files changed in one commit, the current one or any other.
3. **Created at:** every new workset records the branch and commit it was created at.

## Foundation: VS Code's Git API

The built-in Git extension (`vscode.git`) exposes a stable API (`getAPI(1)`) with everything needed, so the extension never runs `git` itself:

| Need | API |
| --- | --- |
| Current branch and commit | `repository.state.HEAD` (`name`, `commit`; no `name` when detached) |
| Merge-base with the base branch | `repository.getMergeBase(ref1, ref2)` |
| Files changed between two commits | `repository.diffBetween(ref1, ref2)` → `Change[]` (`uri`, `renameUri`, `status`) |
| Recent commits | `repository.log({ maxEntries })` |
| Resolve a typed hash, tag or ref | `repository.getCommit(ref)` |
| Branches, for picking a base | `repository.getBranches({ remote: true })` / `getRefs()` |
| Repository for a file | `api.getRepository(uri)` |

- The API's type definitions (`git.d.ts`, MIT) are copied into `src/types/`.
- Git is **optional**. There is no `extensionDependencies` entry. When the Git extension is disabled or the workspace has no repository, the commands and buttons are hidden through a `fileWorksets.hasGitRepo` context key.
- Right after startup the API can still be initializing (`api.state` / `onDidChangeState`). Commands wait for `initialized`, with a timeout.
- Everything is **read-only**: nothing checks out, stashes, fetches or modifies the repository. This keeps "switching has no side effects" true.

### Choosing the repository

1. The repository of the active editor's file, if any.
2. Otherwise, the only repository in the workspace.
3. Otherwise (multi-root, nested repositories), a Quick Pick of repositories.

## 1. Add Files from Branch

**Definition:** the files **committed** on the current branch since it diverged from its base branch. Uncommitted, staged and untracked changes are not included.

- **Diff:** `diffBetween(mergeBase, HEAD)`, where `mergeBase = getMergeBase(HEAD, base)`.
- **Deleted files** are skipped. **Renamed files** are added under their new path (`renameUri ?? uri`).
- Only files inside the workspace folders are added; the rest are counted as skipped, as `addUris` already does.

**Base branch:**

- **Setting:** `fileWorksets.git.baseBranch` (string, window scope). Empty means automatic.
- **Automatic order:** the target of `origin/HEAD`, then `main`, `master` and `develop`. For each name, the remote-tracking branch is tried before the local one.
- **No base found:** a branch picker asks for one. The choice is remembered in workspace state for that repository.
- **On the base branch itself**, or on a branch with no commits of its own, nothing is added, with the message: *"No commits on main since origin/main."*

**Flow:**

```
Add Files from Branch (button, menu, palette)
  → repository = chooseRepository()
  → base = setting ?? remembered ?? detect() ?? pickBranch()
  → mergeBase = repository.getMergeBase('HEAD', base)
  → changes = repository.diffBetween(mergeBase, 'HEAD')
  → uris = changes without deletions, renames mapped to the new path
  → if uris.length > 200: confirm ("Add 340 files from feature/login?")
  → if no workset is active: create one, named after the branch if the name is free
  → actions.addUris(uris, workset)          // existing path; duplicates are no-ops
  → status bar: "Added 23 files from feature/login (4 already in)"
```

## 2. Add Files from Commit…

- **Picker:** a Quick Pick of recent commits (`log`, about 100), each showing the short hash and the subject, with author and relative date as detail. HEAD is first, marked *current*.
- **Any ref:** typing something not in the list (hash, tag, `HEAD~3`) shows a *"Use 'abc123'"* item, resolved with `getCommit`.
- **Diff:** `diffBetween(parent, commit)` against the **first** parent. A root commit is compared with the empty tree (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
- **Deleted files** are skipped, and **renames** use the new path.
- **Files that no longer exist** in the working tree (deleted or renamed after that commit) are **skipped** and counted: *"Added 12 files from 1a2b3c4 (3 no longer exist)"*.
- Adding works as for branches: to the active workset, or a new one if none is active. The confirmation above 200 files applies too.

## 3. Record the branch and commit at creation

**Data:** a new optional field on each workset:

```jsonc
{
	"id": "…",
	"name": "…",
	"createdAt": "2026-11-22T00:16:08.136Z",
	"git": { "branch": "feature/login", "commit": "1a2b3c4d…", "root": "web" },
	"entries": [ … ]
}
```

- `branch` is omitted when HEAD is detached.
- `root` is the workspace folder of the repository, and is only stored in multi-root workspaces.
- **When it's captured:** synchronously in `store.create()`, via a small provider the store calls, from the repository chosen as above (without the picker; the first repository if ambiguous). No Git means no `git` field.
- **Duplicate** records the duplicate's own creation point, not the original's.
- **Storage format:** the version stays **1**. `parseWorksets` and `sanitize` accept and validate the optional field, and `serializeWorksets` writes it. Older builds drop the field when they rewrite the file; nothing else breaks.

**Where it's shown:**

- **Workset tooltip** in the File Worksets list: *"Created on feature/login @ 1a2b3c4"*.
- **Switch/New Workset picker:** in the detail line.
- Worksets created before this feature show nothing.

**Naming:** a workset created *by* Add Files from Branch is named after the branch (for example `feature/login`), if no other workset already uses that name, ignoring case. So is an active workset that's unnamed and still empty. Otherwise it stays unnamed and is labeled by its creation time, as today.

## UI entry points

| Where | Items |
| --- | --- |
| Workset Files empty and no-active rows | **Add Files from Branch ‹name›** (`git-branch` icon) as a third button, only when a repository exists. Tooltip: "Files committed on ‹name› since ‹base›". The diff isn't computed up front; an empty result just shows the message. |
| Workset Files "…" (More Actions) menu, add group | Add Files from Branch, Add Files from Commit… |
| Command Palette | Both commands, when a repository exists |
| Source Control view, file context menu (`scm/resourceState/context`) | **Add to Active Workset**, for the selected files in Changes and Staged Changes |
| Source Control view, group context menu (`scm/resourceGroup/context`) | **Add to Active Workset**, for all files in that group |
| Timeline view, Git commit context menu (`timeline/item/context`) | **Add Files from This Commit to Workset**, if the item passed to the command includes the commit hash (needs verification) |

**Source Control graph** (checked in VS Code 1.147):

- **Dragging commits** works with stable APIs. The graph puts a `scm-history-item` payload on the drag (`[{ resource, historyItem: { id, parentIds, … } }]`, where `resource.path` is the repository root), plus `scm-history-item:` URIs in the URI list. Both views accept it.
- **Right-clicking a commit** (`scm/historyItem/context`) is a **proposed API** (`contribSourceControlHistoryItemMenu`). It's declared in `enabledApiProposals`, which works when running from source (F5), or in an installed build with `"enable-proposed-api": ["local.file-worksets"]` in `argv.json`. Such extensions can't be published to the Marketplace. Arguments: the repository (`rootUri`) and the selected history items (`{ id, parentIds }`).
- **Files inside an expanded commit:** not possible. Their menu (`SCMHistoryItemChangeContext`) isn't open to extensions at all, and they carry no drag data.

## Edge cases

- **Several repositories:** the active editor's repository, otherwise a picker.
- **Detached HEAD:** Add Files from Branch is unavailable (no branch). The message suggests Add Files from Commit… instead.
- **Base branch missing locally and remotely:** branch picker, see above.
- **Shallow clones:** `getMergeBase` can fail. The error message suggests fetching more history, or setting `fileWorksets.git.baseBranch`.
- **Submodules:** treated as separate repositories. Their files are added only if they're inside a workspace folder.
- **Large results:** confirmation above 200 files; the add itself is one batched update.
- **Git still initializing:** commands wait for the API to be ready, with a timeout and a message.

## Implementation plan

1. **Git wrapper** (`src/git.ts`):
   - gets the API lazily and waits for it to initialize,
   - chooses the repository,
   - detects the base branch,
   - maintains the `fileWorksets.hasGitRepo` context key.
2. **Created-at record:** model field, parse/serialize/sanitize, capture in `create()`, tooltip and picker detail.
3. **Add Files from Branch:** command, `baseBranch` setting, empty-state row, "…" menu, branch naming.
4. **Add Files from Commit…:** commit picker with any-ref input.
5. **Source Control menus:** file and group menus, and the Timeline commit menu after verifying its arguments.
6. **Tests:**
   - unit tests for change filtering (deletions, renames, outside-workspace files) and branch naming,
   - integration tests against a temporary Git repository created in the test workspace, skipped when `git` isn't available.
7. **Docs:** FEATURES.md and README.md.
