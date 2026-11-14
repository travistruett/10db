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
    'apps/daemon/src/sessions/codex-generated/**',
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
    // Git-ignored dev state: the dev daemon's data and local scratch.
    '.dev/**',
    // Other checkouts of this repo, each linted on its own branch.
    '.claude/worktrees/**',
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
    languageOptions: { globals: globals.browser },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // Repeated from the block above: a later block replaces a rule's options rather than merging them.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@10db/[^/]+/.+',
              message: 'Import a workspace package through its entry point only.',
            },
          ],
          paths: [
            {
              name: '@10db/contracts',
              importNames: ['providerOf', 'Provider'],
              message:
                "The UI reads an agent's capabilities, never its provider (docs/architecture/decisions/2026-11-12-one-adapter-seam-with-capabilities.md).",
            },
          ],
        },
      ],
    },
  },
  {
    // The conversation kit draws what an agent's capabilities say, never what its harness is.
    files: ['apps/desktop/src/conversation/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` object and a derived type.' },
        ...[
          'BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(claude|codex)$/]',
          'SwitchCase > Literal.test[value=/^(claude|codex)$/]',
          "CallExpression[callee.property.name='includes'] > Literal[value=/^(claude|codex)$/]",
        ].map((selector) => ({
          selector,
          message: 'The kit reads capabilities, never a harness (sessions UI spec §11).',
        })),
      ],
    },
  },
  {
    files: ['apps/desktop/e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Test code names the environment of every git it runs: an inherited GIT_DIR (git exports it
    // to hooks) would aim the command at another repository. See tests/git-isolation.setup.ts.
    files: [
      '**/*.test.{ts,tsx}',
      'apps/daemon/test/**/*.ts',
      'apps/desktop/e2e/**/*.ts',
      'tests/repo/src/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` object and a derived type.' },
        {
          selector:
            "CallExpression[callee.name=/^(execFile|execFileSync|spawn|spawnSync|run)$/][arguments.0.value='git']:not(:has(Property[key.name='env']))",
          message: 'Pass an isolated `env` to git in test code (isolatedGitEnv and the like).',
        },
      ],
    },
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
