import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compileExcludes, globToRegExp } from '../../src/core/glob.ts';
import { branchWorksetName, changedFiles, commitFromArg, commitPickerMatches, detectBaseBranch, historyItemCommits, parseHistoryItemDrag, parseHistoryItemUri } from '../../src/core/git.ts';
import {
	addEntries,
	formatGitOrigin,
	formatRelativeTime,
	parseWorksets,
	removeUnder,
	renameEntries,
	sanitizeEntries,
	serializeWorksets,
	sortWorksets,
	touchIndex,
	validateWorksetName,
	worksetLabel,
	type Workset,
	type WorksetEntry,
} from '../../src/core/model.ts';
import { relativeUriPath, replacePrefix, sanitizeRelativePath } from '../../src/core/paths.ts';
import { buildTrie, compareTreeItems, findNode, listChildren, type LexicographicOrder, type SortItem, type SortOptions } from '../../src/core/tree.ts';

let file = (path: string, root?: string): WorksetEntry => (root ? { kind: 'file', path, root } : { kind: 'file', path });
let folder = (path: string, root?: string): WorksetEntry =>
	root ? { kind: 'folder', path, root } : { kind: 'folder', path };

describe('paths', () => {
	test('sanitizeRelativePath normalizes Windows separators and rejects escapes', () => {
		assert.equal(sanitizeRelativePath('src\\lib\\a.ts'), 'src/lib/a.ts');
		assert.equal(sanitizeRelativePath('./src//a.ts/'), 'src/a.ts');
		for (let bad of ['', '/etc/passwd', 'C:\\Windows', 'c:/x', '../x', 'a/../../x', 'a/./b', 42]) {
			assert.equal(sanitizeRelativePath(bad), undefined, String(bad));
		}
	});

	test('paths from live URIs keep backslashes as part of the name (legal on Linux/macOS)', () => {
		assert.equal(sanitizeRelativePath('dir/a\\b.txt', false), 'dir/a\\b.txt');
		assert.equal(relativeUriPath('/repo', '/repo/dir/a\\b.txt', false), 'dir/a\\b.txt');
		assert.equal(sanitizeRelativePath('../a\\b', false), undefined);
	});

	test('relativeUriPath handles drive-letter case on Windows-like paths', () => {
		assert.equal(relativeUriPath('/C:/Repo', '/c:/repo/src/A.ts', true), 'src/A.ts');
		assert.equal(relativeUriPath('/C:/Repo', '/c:/repo/src/A.ts', false), undefined);
		assert.equal(relativeUriPath('/repo', '/repo', false), undefined);
		assert.equal(relativeUriPath('/repo', '/repository/a', false), undefined);
	});

	test('replacePrefix only matches whole segments', () => {
		assert.equal(replacePrefix('src/lib/a.ts', 'src/lib', 'src/core'), 'src/core/a.ts');
		assert.equal(replacePrefix('src/library/a.ts', 'src/lib', 'x'), undefined);
	});
});

describe('model', () => {
	test('adding the same file twice or a file inside an added folder is a no-op', () => {
		let result = addEntries([], [file('a.ts'), file('a.ts'), folder('src')], undefined);
		assert.deepEqual(result.added, [file('a.ts'), folder('src')]);
		result = addEntries(result.entries, [file('src/x.ts'), folder('src/sub'), file('b.ts')], undefined);
		assert.deepEqual(result.added, [file('b.ts')]);
	});

	test('roots: undefined means the default (first) folder', () => {
		let result = addEntries([file('a.ts')], [file('a.ts', 'web'), file('a.ts', 'api')], 'web');
		assert.deepEqual(result.added, [file('a.ts', 'api')]);
	});

	test('touchIndex matches entries, paths inside folder entries, and folders containing entries', () => {
		let touches = touchIndex([file('src/a.ts'), folder('lib'), file('x.ts', 'api')], 'web');
		for (let path of ['src/a.ts', 'src', 'lib', 'lib/deep/b.ts']) {
			assert.equal(touches(undefined, path), true, path);
		}
		assert.equal(touches('web', 'src'), true);
		for (let path of ['src/b.ts', 'srcx', 'libx/a.ts', 'x.ts']) {
			assert.equal(touches(undefined, path), false, path);
		}
		assert.equal(touches('api', 'x.ts'), true);
	});

	test('removeUnder removes a subtree without touching siblings with similar names', () => {
		let { entries, removed } = removeUnder(
			[file('src/a.ts'), folder('src/lib'), file('srcx/b.ts'), file('src/a.ts', 'other')],
			undefined,
			'src',
			'main',
		);
		assert.deepEqual(removed, [file('src/a.ts'), folder('src/lib')]);
		assert.deepEqual(entries, [file('srcx/b.ts'), file('src/a.ts', 'other')]);
	});

	test('renameEntries follows folder renames and dedupes', () => {
		let { entries, changed } = renameEntries(
			[file('old/a.ts'), folder('old/sub'), file('new/a.ts'), file('keep.ts')],
			{ root: undefined, path: 'old' },
			{ root: undefined, path: 'new' },
			undefined,
		);
		assert.equal(changed, true);
		assert.deepEqual(entries, [file('new/a.ts'), folder('new/sub'), file('keep.ts')]);
	});

	test('serialize/parse round-trips with sorted, diff-friendly output', () => {
		let worksets: Workset[] = [
			{
				id: 'w1',
				name: 'Bug 42',
				createdAt: '2026-01-01T00:00:00.000Z',
				entries: [file('z.ts'), file('a.ts'), folder('lib'), file('x.ts', 'api')],
			},
		];
		let text = serializeWorksets(worksets);
		assert.match(text, /"files": \[\n\s+"a.ts",\n\s+"z.ts",\n\s+\{/);
		let parsed = parseWorksets(text, () => 'unused');
		assert.deepEqual(
			new Set(parsed[0]?.entries.map((e) => `${e.kind}:${e.root ?? ''}:${e.path}`)),
			new Set(['file::z.ts', 'file::a.ts', 'folder::lib', 'file:api:x.ts']),
		);
	});

	test('parseWorksets drops unsafe paths and repairs ids', () => {
		let n = 0;
		let parsed = parseWorksets(
			JSON.stringify({
				worksets: [
					{ id: 'dup', name: 'A', files: ['ok.ts', '../../secret', '/abs', 'C:\\x', 'win\\path.ts'] },
					{ id: 'dup', name: 'B', folders: [{ root: 'api', path: 'src' }, { path: 'noroot' }] },
					{ name: '   ' },
					'garbage',
				],
			}),
			() => `gen${n++}`,
		);
		assert.equal(parsed.length, 3);
		assert.deepEqual(parsed[0]?.entries, [file('ok.ts'), file('win/path.ts')]);
		assert.equal(parsed[1]?.id, 'gen0');
		assert.deepEqual(parsed[1]?.entries, [folder('src', 'api')]);
		assert.equal(parsed[2]?.name, '', 'blank names are kept as unnamed worksets');
		assert.throws(() => parseWorksets('{', () => 'x'));
		assert.throws(() => parseWorksets('[]', () => 'x'));
	});

	test('parseWorksets refuses newer format versions so they are never overwritten', () => {
		assert.throws(() => parseWorksets(JSON.stringify({ version: 2, worksets: [] }), () => 'x'), /version 2/);
		assert.throws(() => parseWorksets(JSON.stringify({ version: '1', worksets: [] }), () => 'x'));
		assert.deepEqual(parseWorksets(JSON.stringify({ version: 1, worksets: [] }), () => 'x'), []);
		assert.deepEqual(parseWorksets(JSON.stringify({ worksets: [] }), () => 'x'), [], 'unversioned (hand-written) data is accepted');
	});

	test('parseWorksets can keep backslashes as part of names (non-Windows)', () => {
		let text = JSON.stringify({ worksets: [{ name: 'A', files: ['dir\\a.ts'] }] });
		assert.deepEqual(parseWorksets(text, () => 'x')[0]?.entries, [file('dir/a.ts')]);
		assert.deepEqual(parseWorksets(text, () => 'x', { backslashIsSeparator: false })[0]?.entries, [file('dir\\a.ts')]);
	});

	test('the Git origin round-trips, and malformed values are dropped', () => {
		let git = { branch: 'feature/login', commit: '1a2b3c4d5e6f' };
		let workset: Workset = { id: 'a', name: 'A', createdAt: '2026-01-01T00:00:00.000Z', entries: [], git };
		assert.deepEqual(parseWorksets(serializeWorksets([workset]), () => 'x')[0]?.git, git);
		let bad = JSON.stringify({ worksets: [{ id: 'a', git: { branch: 'x', commit: 'not a hash' } }, { id: 'b', git: 'main' }] });
		assert.deepEqual(parseWorksets(bad, () => 'x').map((w) => w.git), [undefined, undefined]);
		assert.equal(formatGitOrigin(git), 'feature/login @ 1a2b3c4');
		assert.equal(formatGitOrigin({ commit: '1a2b3c4d5e6f' }), '1a2b3c4', 'detached HEAD has no branch');
	});

	test('sanitizeEntries validates drag-and-drop payloads', () => {
		assert.deepEqual(
			sanitizeEntries([
				{ kind: 'file', path: 'a.ts' },
				{ kind: 'file', path: 'a.ts' },
				{ kind: 'folder', path: 'lib', root: 'api' },
				{ kind: 'other', path: 'x' },
				{ kind: 'file', path: '../escape' },
			]),
			[file('a.ts'), folder('lib', 'api')],
		);
		assert.deepEqual(sanitizeEntries('nope'), []);
	});

	test('validateWorksetName allows empty names but rejects case-insensitive duplicates', () => {
		let existing: Workset[] = [
			{ id: '1', name: 'Feature', createdAt: '', entries: [] },
			{ id: '2', name: '', createdAt: '', entries: [] },
		];
		assert.equal(validateWorksetName('  ', existing), undefined);
		assert.ok(validateWorksetName('feature', existing));
		assert.equal(validateWorksetName('feature', existing, '1'), undefined);
	});

	test('worksetLabel shows the local creation time for unnamed worksets', () => {
		let createdAt = new Date(2026, 10, 20, 9, 5).toISOString();
		assert.equal(worksetLabel({ name: '', createdAt }), '2026-11-20 09:05');
		assert.equal(worksetLabel({ name: 'Bug 42', createdAt }), 'Bug 42');
	});

	test('sortWorksets by last used falls back to creation time', () => {
		let ws = (id: string, name: string, createdAt: string): Workset => ({ id, name, createdAt, entries: [] });
		let list = [ws('a', 'b', '2026-01-01'), ws('b', 'a', '2026-01-03'), ws('c', 'C', '2026-01-02')];
		let lastUsed = { a: '2026-02-01' };
		assert.deepEqual(sortWorksets(list, 'lastUsed', lastUsed).map((w) => w.id), ['a', 'b', 'c']);
		assert.deepEqual(sortWorksets(list, 'created', lastUsed).map((w) => w.id), ['b', 'c', 'a']);
		assert.deepEqual(sortWorksets(list, 'name', lastUsed).map((w) => w.id), ['b', 'a', 'c']);
	});

	test('formatRelativeTime', () => {
		let now = Date.parse('2026-01-10T12:00:00Z');
		assert.equal(formatRelativeTime(undefined, now), 'never');
		assert.equal(formatRelativeTime('2026-01-10T11:59:30Z', now), 'just now');
		assert.equal(formatRelativeTime('2026-01-10T09:00:00Z', now), '3 h ago');
		assert.equal(formatRelativeTime('2026-01-09T11:00:00Z', now), 'yesterday');
		assert.equal(formatRelativeTime('2025-01-01T00:00:00Z', now), '2025-01-01');
	});
});

describe('tree', () => {
	let trie = buildTrie([file('src/lib/deep/a.ts'), file('src/lib/deep/b.ts'), file('README.md'), folder('docs/api')]);

	test('only folders leading to entries exist, folders first', () => {
		assert.deepEqual(
			listChildren(trie, false).map((c) => c.label),
			['docs', 'src', 'README.md'],
		);
	});

	test('compacts single-child folder chains but stops at folder entries', () => {
		assert.deepEqual(
			listChildren(trie, true).map((c) => [c.label, c.node.path]),
			[
				['docs/api', 'docs/api'],
				['src/lib/deep', 'src/lib/deep'],
				['README.md', 'README.md'],
			],
		);
		assert.equal(findNode(trie, 'docs/api')?.isFolderEntry, true);
		assert.equal(findNode(trie, 'nope'), undefined);
	});

	test('sorts like the Explorer for each explorer.sortOrder setting', () => {
		let items: SortItem[] = [
			{ isDirectory: false, name: 'b.ts' },
			{ isDirectory: true, name: 'src' },
			{ isDirectory: false, name: 'a.md' },
			{ isDirectory: false, name: 'file10.ts' },
			{ isDirectory: false, name: 'file2.ts' },
			{ isDirectory: true, name: 'Docs' },
		];
		let sorted = (options: SortOptions): string[] =>
			[...items].sort((a, b) => compareTreeItems(a, b, options)).map((i) => i.name);
		assert.deepEqual(sorted({ order: 'default', lexicographic: 'default' }), ['Docs', 'src', 'a.md', 'b.ts', 'file2.ts', 'file10.ts']);
		assert.deepEqual(sorted({ order: 'filesFirst', lexicographic: 'default' }), ['a.md', 'b.ts', 'file2.ts', 'file10.ts', 'Docs', 'src']);
		assert.deepEqual(sorted({ order: 'mixed', lexicographic: 'default' }), ['a.md', 'b.ts', 'Docs', 'file2.ts', 'file10.ts', 'src']);
		assert.deepEqual(sorted({ order: 'type', lexicographic: 'default' }), ['Docs', 'src', 'a.md', 'b.ts', 'file2.ts', 'file10.ts']);
		assert.deepEqual(sorted({ order: 'default', lexicographic: 'unicode' }), ['Docs', 'src', 'a.md', 'b.ts', 'file10.ts', 'file2.ts']);
	});

	test('upper/lower group by the case of the first letter, like VS Code', () => {
		let names = ['a.ts', 'Z.ts', 'b.ts', 'C.ts'];
		let sorted = (lexicographic: LexicographicOrder): string[] =>
			names
				.map((name): SortItem => ({ isDirectory: false, name }))
				.sort((a, b) => compareTreeItems(a, b, { order: 'default', lexicographic }))
				.map((i) => i.name);
		assert.deepEqual(sorted('upper'), ['C.ts', 'Z.ts', 'a.ts', 'b.ts']);
		assert.deepEqual(sorted('lower'), ['a.ts', 'b.ts', 'C.ts', 'Z.ts']);
		assert.deepEqual(sorted('default'), ['a.ts', 'b.ts', 'C.ts', 'Z.ts']);
	});

	test('compacted folders sort by their first segment', () => {
		let chains = buildTrie([file('b/only/x.ts'), file('a-b/y.ts'), file('a/z.ts')]);
		assert.deepEqual(
			listChildren(chains, true).map((c) => c.label),
			['a', 'a-b', 'b/only'],
		);
	});
});

describe('git', () => {
	test('changedFiles drops deletions and follows renames', () => {
		let changes = [
			{ uri: 'a.ts', status: 5 }, // MODIFIED
			{ uri: 'b.ts', status: 1 }, // INDEX_ADDED
			{ uri: 'gone.ts', status: 6 }, // DELETED
			{ uri: 'staged-gone.ts', status: 2 }, // INDEX_DELETED
			{ uri: 'old.ts', renameUri: 'new.ts', status: 3 }, // INDEX_RENAMED
		];
		assert.deepEqual(changedFiles(changes), ['a.ts', 'b.ts', 'new.ts']);
	});

	test('detectBaseBranch prefers the remote default and never picks the current branch', () => {
		assert.equal(detectBaseBranch(['main', 'origin/main', 'origin/HEAD', 'feature'], 'feature'), 'origin/HEAD');
		assert.equal(detectBaseBranch(['main', 'master', 'feature'], 'feature'), 'main');
		assert.equal(detectBaseBranch(['main', 'develop'], 'main'), 'develop');
		assert.equal(detectBaseBranch(['feature', 'other'], 'feature'), undefined);
	});

	test('branchWorksetName uses the branch unless the name is taken (ignoring case)', () => {
		assert.equal(branchWorksetName('feature/login', ['Other']), 'feature/login');
		assert.equal(branchWorksetName('feature/login', ['Feature/Login']), '');
	});

	test('commitFromArg accepts refs and Timeline-like items', () => {
		assert.equal(commitFromArg(' HEAD~1 '), 'HEAD~1');
		assert.equal(commitFromArg({ ref: '1a2b3c4d', id: 'x' }), '1a2b3c4d');
		assert.equal(commitFromArg({ id: '1a2b3c4d5e' }), '1a2b3c4d5e');
		assert.equal(commitFromArg({ id: 'working' }), undefined);
		assert.equal(commitFromArg(undefined), undefined);
	});

	test('commit picker: pasted hashes find listed commits, other ref-like text offers "Use"', () => {
		let hashes = ['1a2b3c4d5e6f7081', 'ffff000011112222'];
		assert.deepEqual(commitPickerMatches(' 1A2B3C4D5E6F7081 ', hashes), { hashMatches: ['1a2b3c4d5e6f7081'], offerRef: false });
		assert.deepEqual(commitPickerMatches('1a2b', hashes), { hashMatches: ['1a2b3c4d5e6f7081'], offerRef: false });
		assert.deepEqual(commitPickerMatches('abcdef1234567890', hashes), { hashMatches: [], offerRef: true }, 'not in the list');
		assert.deepEqual(commitPickerMatches('v1.2.0', hashes), { hashMatches: [], offerRef: true });
		assert.deepEqual(commitPickerMatches('fix login', hashes), { hashMatches: [], offerRef: false }, 'searching messages');
		assert.deepEqual(commitPickerMatches('', hashes), { hashMatches: [], offerRef: false });
	});

	test('Source Control graph: drag payloads, commit URIs and menu arguments', () => {
		let drag = JSON.stringify([
			{ name: 'repo 1a2b3c4', resource: { scheme: 'scm-history-item', path: 'c:\\repo' }, historyItem: { id: '1a2b3c4d5e', parentIds: [] } },
			{ historyItem: { id: 'not-a-hash' } },
		]);
		assert.deepEqual(parseHistoryItemDrag(drag), [{ commit: '1a2b3c4d5e', rootPath: 'c:\\repo' }]);
		assert.deepEqual(parseHistoryItemDrag('nope'), []);
		assert.deepEqual(parseHistoryItemUri('/repo', JSON.stringify({ repositoryId: '1', historyItemId: 'abcdef12' })), {
			commit: 'abcdef12',
			rootPath: '/repo',
		});
		assert.equal(parseHistoryItemUri('/repo', '{'), undefined);
		let item = { id: 'abcdef12', parentIds: ['0000000'] };
		assert.deepEqual(historyItemCommits([{ rootUri: {} }, item, [item, { id: 'fedcba98', parentIds: [] }], { id: 'abcdef12' }]), [
			'abcdef12',
			'fedcba98',
		]);
	});
});

describe('glob', () => {
	test('matches files.exclude style patterns', () => {
		let cases: [string, string, boolean][] = [
			['**/.git', '.git', true],
			['**/.git', 'a/b/.git', true],
			['**/.git', 'a/.github', false],
			['**/*.{js,map}', 'out/a.map', true],
			['**/*.{js,map}', 'out/a.ts', false],
			['node_modules', 'node_modules', true],
			['node_modules', 'a/node_modules', false],
			['build/**', 'build/x/y', true],
			['file?.[!a]s', 'file1.ts', true],
			['file?.[!a]s', 'file1.as', false],
		];
		for (let [glob, path, expected] of cases) {
			assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`);
		}
	});

	test('compileExcludes ignores disabled and conditional patterns', () => {
		let patterns = compileExcludes({ '**/.git': true, '**/*.js': { when: '$(basename).ts' }, '**/off': false });
		assert.equal(patterns.length, 1);
	});

	test('compileExcludes skips invalid patterns instead of throwing', () => {
		let patterns = compileExcludes({ '**/{a,b': true, '**/.git': true });
		assert.equal(patterns.length, 1);
		assert.ok(patterns[0]?.test('x/.git'));
	});
});
