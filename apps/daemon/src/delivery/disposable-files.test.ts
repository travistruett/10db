import { describe, expect, it } from 'vitest';
import { isDisposable } from './disposable-files';

describe('isDisposable', () => {
  it.each<{ name: string; file: string; disposable: boolean }>([
    { name: "the typecheck's build info", file: 'tsconfig.tsbuildinfo', disposable: true },
    {
      name: "a package's build info",
      file: 'apps/daemon/tsconfig.build.tsbuildinfo',
      disposable: true,
    },
    { name: "eslint's cache", file: '.eslintcache', disposable: true },
    { name: "a package's eslint cache", file: 'apps/web/.eslintcache', disposable: true },
    { name: "Finder's file", file: '.DS_Store', disposable: true },
    { name: "Finder's file in a folder", file: 'src/.DS_Store', disposable: true },
    { name: 'a bundle under dist', file: 'apps/desktop/dist/index.js', disposable: true },
    { name: "cargo's output under target", file: 'src-tauri/target/debug/app', disposable: true },
    { name: 'a coverage report', file: 'coverage/lcov.info', disposable: true },
    { name: "the gate's logs", file: '.gate/steps/lint.log', disposable: true },
    { name: 'a hand-made .env', file: '.env', disposable: false },
    { name: 'local settings', file: '.claude/settings.local.json', disposable: false },
    { name: 'a personal mise file', file: 'mise.local.toml', disposable: false },
    { name: 'a log the builder may still need', file: 'debug.log', disposable: false },
    { name: 'a file named like an output directory', file: 'dist', disposable: false },
    { name: 'a file named target in a folder', file: 'deploy/target', disposable: false },
    {
      name: 'a directory whose name only starts so',
      file: 'distribution/notes.md',
      disposable: false,
    },
    { name: 'a capitalised output name', file: 'Dist/notes.md', disposable: false },
    { name: 'build info that is not the suffix', file: 'notes.tsbuildinfo.md', disposable: false },
  ])('$name ($file): $disposable', ({ file, disposable }) => {
    expect(isDisposable(file)).toBe(disposable);
  });
});
