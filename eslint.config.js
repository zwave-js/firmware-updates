import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
	// Global ignores (replaces .eslintignore)
	{
		ignores: [
			'build/**',
			'node_modules/**',
			'**/node_modules/**',
			'.*',
			'*.config.js',
			'*.config.mjs',
			'docs/marked.min.js',
			'src/maintenance/**/*.mjs',
		],
	},

	...tseslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	
	{
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: __dirname,
			},
		},
		linterOptions: {
			reportUnusedDisableDirectives: true,
		},
		rules: {
			// Custom rules from original config
			'@typescript-eslint/no-parameter-properties': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-use-before-define': [
				'error',
				{
					functions: false,
					typedefs: false,
					classes: false,
				},
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					ignoreRestSiblings: true,
					argsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/no-object-literal-type-assertion': 'off',
			'@typescript-eslint/interface-name-prefix': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-inferrable-types': [
				'error',
				{
					ignoreProperties: true,
					ignoreParameters: true,
				},
			],
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-expect-error': false,
					'ts-ignore': true,
					'ts-nocheck': true,
					'ts-check': false,
				},
			],
			'@typescript-eslint/restrict-template-expressions': [
				'error',
				{
					allowNumber: true,
					allowBoolean: true,
					allowAny: true,
					allowNullish: true,
				},
			],
			'@typescript-eslint/no-misused-promises': [
				'error',
				{
					checksVoidReturn: false,
				},
			],
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-implied-eval': 'off',
			'@typescript-eslint/explicit-module-boundary-types': [
				'warn',
				{ allowArgumentsExplicitlyTypedAsAny: true },
			],
			'@typescript-eslint/no-this-alias': 'off',
			'dot-notation': 'off',
			'@typescript-eslint/dot-notation': [
				'error',
				{
					allowPrivateClassPropertyAccess: true,
					allowProtectedClassPropertyAccess: true,
				},
			],
			'quote-props': ['error', 'as-needed'],
		},
	},
	
	// Use different tsconfig for maintenance scripts (Node.js environment)
	{
		files: ['src/maintenance/**/*.ts'],
		ignores: ['src/maintenance/**/*.mjs'],
		languageOptions: {
			parserOptions: {
				project: './src/maintenance/tsconfig.json',
				tsconfigRootDir: __dirname,
			},
		},
	},
	
	// Test files override
	{
		files: ['**/*.test.ts'],
		rules: {
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-member-return': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/unbound-method': 'off',
			'@typescript-eslint/no-unused-vars': 'warn',
			'@typescript-eslint/dot-notation': 'off',
		},
	},
	
	// Disable all TS-related rules for JS files  
	{
		files: ['**/*.js', '**/*.mjs'],
		rules: {
			'@typescript-eslint/*': 'off',
		},
	},
	
	// Prettier integration (must be last)
	prettierConfig,
);
