import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DMG_NAME,
  HEAD_SHA,
  installedAppSandbox,
  type InstalledAppSandbox,
} from './installed-app-sandbox';

const STAMP = '20261029T101500Z';

let box: InstalledAppSandbox;
let stageDir: string;
let statusFile: string;
beforeEach(() => {
  box = installedAppSandbox();
  stageDir = join(mkdtempSync(join(box.root, 'stage-')), 'staged');
  statusFile = join(box.root, 'status.json');
});
afterEach(() => {
  box.remove();
});

const run = (args: readonly string[], env: Record<string, string> = {}) =>
  box.run('install-app.sh', ['--status-file', statusFile, ...args], {
    TENDB_INSTALL_STAMP: STAMP,
    TENDB_INSTALL_QUIT_POLL_SECONDS: '0',
    ...env,
  });
const stage = (env: Record<string, string> = {}, extra: readonly string[] = []) =>
  run(['--stage', stageDir, ...extra], env);
const apply = (env: Record<string, string> = {}) =>
  run(['--apply', stageDir, '--quit-first', '--relaunch'], {
    // The app is running when the script starts, and gone after it was asked to quit.
    STUB_RUNNING: '57868',
    STUB_RUNNING_UNTIL_CALL: '1',
    ...env,
  });
const status = (): Record<string, unknown> =>
  JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
const app = () => join(box.applications, '10db.app');
const opened = () => box.calls().filter((call) => call.startsWith('open '));
const pkills = () => box.calls().filter((call) => call.startsWith('pkill '));
const osascripts = () => box.calls().filter((call) => call.startsWith('osascript '));
const gh = () => box.calls().filter((call) => call.startsWith('gh '));

describe('install-app.sh --stage', () => {
  it('fetches and verifies the build while 10db runs, and touches nothing installed', () => {
    const result = stage({ STUB_RUNNING: '57868' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(join(stageDir, DMG_NAME), 'utf8')).toBe('disk image bytes');
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(HEAD_SHA);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', commit: HEAD_SHA });
    expect(box.marker(app())).toBe('old build');
    expect(box.list(box.previousDir)).toEqual([]);
    expect(
      box
        .calls()
        .filter((call) => /^(sqlite3|hdiutil|ditto|xattr|lsregister|pkill|open) /.test(call)),
    ).toEqual([]);
  });

  it('stages only a commit whose CI finished green, and nothing when none has', () => {
    const OLD = 'f'.repeat(40);
    // The head has a finished build but red CI; the commit before it is green.
    const result = stage({
      STUB_COMMITS: `${HEAD_SHA} ${OLD}`,
      STUB_CI_GREEN: OLD,
      STUB_RUNS: `201@${OLD}`,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(OLD);

    const none = run(['--stage', join(box.root, 'other'), '--running', OLD], {
      STUB_COMMITS: `${HEAD_SHA} ${OLD}`,
      STUB_CI_GREEN: '',
    });
    expect(none.status).toBe(0);
    expect(existsSync(join(box.root, 'other', 'commit'))).toBe(false);

    // The running commit is newer than the newest green one: nothing to fetch or build.
    const ahead = run(['--stage', join(box.root, 'ahead'), '--running', HEAD_SHA], {
      STUB_COMMITS: `${HEAD_SHA} ${OLD}`,
      STUB_CI_GREEN: OLD,
    });
    expect(ahead.status).toBe(0);
    expect(existsSync(join(box.root, 'ahead', 'commit'))).toBe(false);
    expect(box.calls().filter((call) => call.startsWith('gh workflow run'))).toEqual([]);

    // The green commit has no live build, so a build of the ref's head is waited for: it is of a
    // commit with red CI, and is not staged.
    const dispatched = run(['--stage', join(box.root, 'waited'), '--running', 'e'.repeat(40)], {
      STUB_COMMITS: `${HEAD_SHA} ${OLD}`,
      STUB_CI_GREEN: OLD,
      STUB_SUCCESS_RUN: '',
    });
    expect(dispatched.status).toBe(0);
    expect(existsSync(join(box.root, 'waited', 'commit'))).toBe(false);
  });

  it.each([
    {
      name: 'GitHub cannot be reached',
      env: { STUB_GH_OFFLINE: '1' },
      step: 'find-commit',
      message: 'could not ask GitHub',
    },
    {
      name: 'the build failed',
      env: { STUB_SUCCESS_RUN: '', STUB_RUN_CONCLUSION: 'failure' },
      step: 'wait-for-build',
      message: 'ended in failure',
    },
    {
      name: 'the DMG does not match its checksum',
      env: {},
      step: 'verify-checksum',
      message: 'checksum mismatch',
      before: () => {
        box.corruptChecksum();
      },
    },
  ])('reports the step that failed when $name', ({ env, step, message, before }) => {
    before?.();
    const result = stage(env);
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'stage', step });
    expect(String(status()['message'])).toContain(message);
    expect(existsSync(join(stageDir, DMG_NAME))).toBe(false);
    expect(box.marker(app())).toBe('old build');
  });
});

describe('install-app.sh --apply', () => {
  beforeEach(() => {
    expect(stage().status).toBe(0);
  });

  it('quits the app, installs the staged build without asking GitHub, and starts it again', () => {
    const before = gh().length;
    const result = apply();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gh()).toHaveLength(before);
    // Asked as ⌘Q asks, through the app's own quit; nothing is signalled.
    expect(osascripts()).toHaveLength(1);
    expect(osascripts()[0]).toContain('app.10db.desktop');
    expect(osascripts()[0]).toContain('quit');
    expect(pkills()).toEqual([]);
    expect(box.marker(app())).toBe('new build');
    expect(box.list(box.previousDir)).toEqual([`10db-${STAMP}.zip`]);
    expect(box.zipMarker(`10db-${STAMP}.zip`)).toBe('old build');
    expect(opened()).toEqual([`open ${app()}`]);
    expect(status()).toMatchObject({ ok: true, mode: 'apply', commit: HEAD_SHA });
  });

  it('sees the app that started it, and installs nothing over it', () => {
    const result = apply({
      STUB_APP_IS_ANCESTOR: '1',
      STUB_RUNNING_UNTIL_CALL: '999',
      TENDB_INSTALL_QUIT_SECONDS: '2',
    });
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'quit' });
    expect(box.marker(app())).toBe('old build');
  });

  it('puts the old app back and starts it again when the install fails after the quit', () => {
    const result = apply({ STUB_DITTO_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'install' });
    expect(box.marker(app())).toBe('old build');
    expect(opened()).toEqual([`open ${app()}`]);
  });

  it('names the backup as the step when the database cannot be backed up, and starts the old app', () => {
    const result = apply({ STUB_SQLITE_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, step: 'backup-database' });
    expect(box.marker(app())).toBe('old build');
    expect(opened()).toEqual([`open ${app()}`]);
  });
});
