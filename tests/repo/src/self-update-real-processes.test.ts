import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

// The tests that use macOS's own pgrep and pkill. Linux's pgrep reads -a as "list in full", and a
// lane's sandbox cannot read the process list at all (pgrep exits 3), so they run on a Mac outside
// a sandbox: the desktop job in CI runs this file. installed-app-sandbox.ts narrows the real tools to
// this test's own processes, so they never reach a 10db running on the Mac.
const canListProcesses =
  process.platform === 'darwin' &&
  spawnSync('/usr/bin/pgrep', ['-a', '-f', '^no such process anywhere$']).status === 1;

describe.skipIf(!canListProcesses)('the update run by the app it replaces', () => {
  const STAMP = '20261029T101500Z';
  let box: InstalledAppSandbox;
  let stageDir: string;
  let statusFile: string;

  beforeEach(() => {
    box = installedAppSandbox();
    stageDir = join(mkdtempSync(join(box.root, 'stage-')), 'staged');
    statusFile = join(box.root, 'status.json');
    const staged = box.run('install-app.sh', ['--status-file', statusFile, '--stage', stageDir]);
    expect(staged.status).toBe(0);
    rmSync(statusFile);
  });
  afterEach(() => {
    box.remove();
  });

  const app = () => join(box.applications, '10db.app');
  const status = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
  const update = (daemonGivesPids: boolean, env: Record<string, string>) =>
    box.runUnderApp(
      'install-app.sh',
      ['--status-file', statusFile, '--apply', stageDir, '--quit-first', '--relaunch'],
      {
        windowUntil: statusFile,
        daemonGivesPids,
        env: {
          TENDB_INSTALL_STAMP: STAMP,
          TENDB_INSTALL_QUIT_POLL_SECONDS: '0.05',
          ...env,
        },
      },
    );

  it('ends the window with a signal when the quit request is refused, then installs', () => {
    update(true, { STUB_OSASCRIPT_FAILS: '1', TENDB_INSTALL_QUIT_SECONDS: '100' });
    expect(status()).toMatchObject({ ok: true, mode: 'apply' });
    expect(box.marker(app())).toBe('new build');
  }, 30_000);

  it('finds the window and the daemon by name, though they are its ancestors, and installs nothing over them', () => {
    // A quit request that is taken but does nothing, and no pids to fall back on: the incident.
    update(false, { TENDB_INSTALL_QUIT_SECONDS: '3' });
    expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'quit' });
    expect(String(status()['message'])).toContain('10db could not be quit');
    expect(box.marker(app())).toBe('old build');
  }, 30_000);
});
