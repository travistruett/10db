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
});
