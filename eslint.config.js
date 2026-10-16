// @ts-check
import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/generated/**',
    'packages/db/drizzle/**',
    'apps/desktop/src-tauri/target/**',
    'apps/desktop/src-tauri/resources/**',
    'apps/desktop/src-tauri/binaries/**',
    'apps/desktop/src-tauri/gen/**',
    'tests/repo/fixtures/**',
    'spikes/**',
    'scratch/**',
    '.superpowers/**',
    '.gate/**',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@10db/[^/]+/.+',
              message: 'Import a workspace package through its entry point only.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` object and a derived type.' },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    plugins: { 'jsx-a11y': fixupPluginRules(jsxA11y) },
    rules: jsxA11y.flatConfigs.strict.rules,
    languageOptions: { globals: globals.browser },
  },
  {
    // Daemon modules (src/<module>/) import each other only through index.ts.
    files: ['apps/daemon/src/*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@10db/[^/]+/.+',
              message: 'Import a workspace package through its entry point only.',
            },
            // `(?!\\.\\.)` lets tests reach `../../test/fixtures`; only sibling modules are restricted.
            {
              regex: '^\\.\\./(?!\\.\\.)[^/]+/.+',
              message: 'Import another daemon module through its index.ts only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/daemon/src/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@10db/[^/]+/.+',
              message: 'Import a workspace package through its entry point only.',
            },
            {
              regex: '^\\./[^/]+/.+',
              message: 'Import a daemon module through its index.ts only.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
