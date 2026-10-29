import { describe, expect, it } from 'vitest';
import { readRepoFile } from './workspace';

// The daemon accepts only the Tauri webview's origins unless a launcher opts a browser origin in, so
// each daemon a browser UI on Vite's port 1420 talks to sets TENDB_DEV_UI_ORIGIN to it.
describe('daemons a browser UI on port 1420 reaches', () => {
  const VITE_ORIGIN = /TENDB_DEV_UI_ORIGIN\s*[:=]\s*['"]?http:\/\/localhost:1420\b/;

  it.each([
    ['pnpm dev', 'scripts/dev.sh'],
    ['the live acceptance daemon', 'apps/daemon/scripts/live-acceptance.ts'],
  ])('%s opts the Vite origin in', (_name, path) => {
    expect(readRepoFile(path)).toMatch(VITE_ORIGIN);
  });

  it('pnpm dev:factory says how to opt the installed app in', () => {
    expect(readRepoFile('apps/desktop/scripts/factory-connection.ts')).toContain(
      'open -a 10db --env TENDB_DEV_UI_ORIGIN=',
    );
    expect(readRepoFile('apps/desktop/scripts/factory-connection.ts')).toContain(
      "VITE_ORIGIN = 'http://localhost:1420'",
    );
  });
});
