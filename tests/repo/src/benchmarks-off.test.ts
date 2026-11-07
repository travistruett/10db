import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

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

  it.each([
    ['the e2e web server', 'apps/desktop/e2e/playwright.config.ts'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s turns the catalogue fetch off', (_name, path) => {
    expect(readRepoFile(path)).toMatch(CATALOGUE_OFF);
  });

  it('pnpm dev leaves the catalogue fetch on', () => {
    expect(readRepoFile('scripts/dev.sh')).not.toMatch(CATALOGUE_OFF);
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
