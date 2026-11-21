// TypeScript 7 (the native port) has no JavaScript API, and typescript-eslint needs one to parse files.
// Until typescript-eslint supports TS 7, resolve `typescript` to the TS 6 API for ESLint only.
// Type checking (`npm run typecheck`) still uses TypeScript 7.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === 'typescript' ? '@typescript/typescript6' : specifier, context);
	},
});

let { defineConfig } = await import('eslint/config');
let { default: tseslint } = await import('typescript-eslint');
let { default: stylistic } = await import('@stylistic/eslint-plugin');
let { default: preferLet } = await import('eslint-plugin-prefer-let');

export default defineConfig(
	{ ignores: ['dist/', 'out/', '.vscode-test/'] },
	{
		files: ['**/*.{ts,mjs}'],
		extends: [tseslint.configs.recommended],
		plugins: { '@stylistic': stylistic, 'prefer-let': preferLet },
		rules: {
			// `let` for all bindings; `const` only for top-level UPPER_CASE constants (like PI).
			'prefer-const': 'off',
			'prefer-let/prefer-let': ['error', { forceUpperCaseConst: true }],
			// Tabs for indentation, spaces only for alignment.
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/no-mixed-spaces-and-tabs': ['error', 'smart-tabs'],
		},
	},
);
