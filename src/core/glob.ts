/**
 * Minimal glob matcher for `files.exclude` patterns (`**`, `*`, `?`, `{a,b}`,
 * `[abc]`, `[!abc]`), matched against workspace-relative `/`-separated paths.
 */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	let inGroup = false;
	for (let i = 0; i < glob.length; i++) {
		let char = glob[i] as string;
		if (char === '*') {
			if (glob[i + 1] === '*') {
				let atSegmentStart = i === 0 || glob[i - 1] === '/';
				if (atSegmentStart && glob[i + 2] === '/') {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else if (char === '{') {
			inGroup = true;
			source += '(?:';
		} else if (char === '}' && inGroup) {
			inGroup = false;
			source += ')';
		} else if (char === ',' && inGroup) {
			source += '|';
		} else if (char === '[' && glob.indexOf(']', i + 2) !== -1) {
			let end = glob.indexOf(']', i + 2);
			let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
			if (body.startsWith('!')) {
				body = `^${body.slice(1)}`;
			}
			source += `[${body}]`;
			i = end;
		} else {
			source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`);
}

/** Compiles the enabled (boolean `true`) patterns of a `files.exclude`-style object. */
export function compileExcludes(config: Readonly<Record<string, unknown>> | undefined): RegExp[] {
	if (!config) {
		return [];
	}
	return Object.entries(config)
		.filter(([, enabled]) => enabled === true)
		.map(([pattern]) => globToRegExp(pattern));
}
