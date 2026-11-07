import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from './workspace';

// Only the installed app's daemon may call Artificial Analysis: its free quota is shared by the
// builder's key, and a throwaway daemon with no prior sync would spend it.
describe('daemons that are not the installed app', () => {
  const OFF = /TENDB_BENCHMARKS\s*[:=]\s*['"]?off\b/;

  it.each([
    ['the e2e web server', 'apps/desktop/e2e/playwright.config.ts'],
    ['pnpm dev', 'scripts/dev.sh'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s turns the benchmark sync off', (_name, path) => {
    expect(readRepoFile(path)).toMatch(OFF);
  });

  // The catalogue is one keyless GET a day, so `pnpm dev` keeps it on and sees real data.
  const CATALOGUE_OFF = /TENDB_CATALOGUE\s*[:=]\s*['"]?off\b/;
  // With the fetch off a daemon still needs a catalogue to build model profiles from, so it names a file.
  const CATALOGUE_SNAPSHOT = /TENDB_CATALOGUE_SNAPSHOT\s*[:=]/;

  it.each([
    ['the e2e web server', 'apps/desktop/e2e/playwright.config.ts'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s turns the catalogue fetch off and names a snapshot file', (_name, path) => {
    expect(readRepoFile(path)).toMatch(CATALOGUE_OFF);
    expect(readRepoFile(path)).toMatch(CATALOGUE_SNAPSHOT);
  });

  it('pnpm dev leaves the catalogue fetch on', () => {
    expect(readRepoFile('scripts/dev.sh')).not.toMatch(CATALOGUE_OFF);
  });

  // A test that spawns the daemon's entry builds its own environment, so it inherits nothing.
  const SPAWNS_DAEMON = /spawn\(process\.execPath, \[[^\]]*(?:src\/main\.ts|daemon\.mjs)/;

  it('every daemon test that spawns the entry turns the catalogue fetch off and names a snapshot file', () => {
    const spawners = globSync(['apps/daemon/src/**/*.test.ts', 'apps/daemon/test/**/*.test.ts'], {
      cwd: repoRoot,
    }).filter((path) => SPAWNS_DAEMON.test(readRepoFile(path)));
    expect(spawners.length).toBeGreaterThanOrEqual(4);
    expect(
      spawners.filter(
        (path) =>
          !CATALOGUE_OFF.test(readRepoFile(path)) || !CATALOGUE_SNAPSHOT.test(readRepoFile(path)),
      ),
    ).toEqual([]);
  });

  // The judge sends task text and diffs to OpenRouter on the builder's key and spends it.
  const JUDGE_OFF = /TENDB_JUDGE\s*[:=]\s*['"]?off\b/;

  it.each([
    ['the e2e web server', 'apps/desktop/e2e/playwright.config.ts'],
    ['pnpm dev', 'scripts/dev.sh'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s turns the judge off', (_name, path) => {
    expect(readRepoFile(path)).toMatch(JUDGE_OFF);
  });
});
