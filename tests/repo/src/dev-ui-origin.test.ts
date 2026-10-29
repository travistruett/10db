import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

// The daemon accepts only the Tauri webview's origins unless a launcher opts a browser origin in, so
// each daemon a browser UI on Vite's port 1420 talks to sets TENDB_DEV_UI_ORIGIN to it.
describe('daemons a browser UI on port 1420 reaches', () => {
  const VITE_ORIGIN = /TENDB_DEV_UI_ORIGIN\s*[:=]\s*['"]?http:\/\/localhost:1420\b/;
  /** The file without its comment lines, so a commented-out setting doesn't count. */
  const code = (path: string): string =>
    readRepoFile(path)
      .split('\n')
      .filter((line) => !/^\s*(#|\/\/)/.test(line))
      .join('\n');

  it.each([
    ['pnpm dev', 'scripts/dev.sh'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s opts the Vite origin in', (_name, path) => {
    expect(code(path)).toMatch(VITE_ORIGIN);
  });

  it('runs pnpm dev:factory:enable and :disable from the root', () => {
    const root = readRepoFile('package.json');
    expect(root).toContain(
      '"dev:factory:enable": "pnpm --filter @10db/desktop dev:factory:enable"',
    );
    expect(root).toContain(
      '"dev:factory:disable": "pnpm --filter @10db/desktop dev:factory:disable"',
    );
  });

  // One recipe, in both places: the README section is the reference and CONTRIBUTING.md links to it.
  it.each(['README.md', 'CONTRIBUTING.md'])('%s carries the same when/run table', (doc) => {
    const rows = [
      [
        'Once, and after each Mac restart',
        '`pnpm dev:factory:enable`, then quit 10db (⌘Q) and open it again',
      ],
      ['Every time', '`pnpm dev:factory`, then open http://localhost:1420'],
      ['To turn it off', '`pnpm dev:factory:disable`, then quit and reopen 10db'],
    ];
    const cells = readRepoFile(doc)
      .split('\n')
      .filter((line) => line.trim().startsWith('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    for (const row of rows) expect(cells).toContainEqual(row);
  });

  it('CONTRIBUTING.md links to the README section', () => {
    expect(readRepoFile('CONTRIBUTING.md')).toContain(
      '(README.md#hot-reload-the-ui-over-your-real-10db)',
    );
    expect(readRepoFile('README.md')).toContain('## Hot-reload the UI over your real 10db');
  });
});
