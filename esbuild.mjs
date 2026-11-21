import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

let args = new Set(process.argv.slice(2));
let production = args.has('--production');
let watch = args.has('--watch');
let tests = args.has('--tests');

/** @type {import('esbuild').BuildOptions} */
let common = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['vscode'],
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
let options = tests
	? {
		...common,
		entryPoints: readdirSync('test/integration')
			.filter((name) => name.endsWith('.test.ts'))
			.map((name) => `test/integration/${name}`),
		outdir: 'out/integration',
		outExtension: { '.js': '.cjs' },
	}
	: {
		...common,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.cjs',
	};

if (watch) {
	let context = await esbuild.context(options);
	await context.watch();
} else {
	await esbuild.build(options);
}
