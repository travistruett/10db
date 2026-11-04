import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DMG_NAME,
  HEAD_SHA,
  installedAppSandbox,
  type InstalledAppSandbox,
} from './installed-app-sandbox';

const STAMP = '20261029T101500Z';
/** A commit before the head, newest first after it: the head's own build has not finished. */
const OLDER = '1111111111111111111111111111111111111111';

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

  it('stages the newest finished build when the head’s has not finished, as an install does', () => {
    const result = stage({
      STUB_SUCCESS_RUN: '',
      STUB_COMMITS: `${HEAD_SHA} ${OLDER}`,
      STUB_RUNS: `7@${OLDER}`,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(OLDER);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', commit: OLDER });
  });

  it('leaves the installer scripts with the build, so the app that replaces itself can run them', () => {
    expect(stage().status).toBe(0);
    for (const name of ['install-app.sh', 'installed-app.sh']) {
      expect(existsSync(join(stageDir, 'scripts', 'release', name))).toBe(true);
    }
  });

  it('fetches nothing when the newest finished build is the one that runs', () => {
    const result = stage({}, ['--running', HEAD_SHA]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'current', commit: HEAD_SHA });
    expect(gh().filter((call) => call.startsWith('gh run download'))).toEqual([]);
    expect(existsSync(stageDir)).toBe(false);
  });

  it('fetches nothing when the newest finished build is the one it was told to skip', () => {
    const result = stage({}, ['--running', OLDER, '--skip', HEAD_SHA]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'skipped', commit: HEAD_SHA });
    expect(gh().filter((call) => call.startsWith('gh run download'))).toEqual([]);
    expect(existsSync(stageDir)).toBe(false);
  });

  it('stages the newest finished build when it is not the one to skip', () => {
    const result = stage({}, ['--running', OLDER, '--skip', OLDER]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'done', commit: HEAD_SHA });
  });

  it('fetches nothing, and leaves the folder as it is, when the newest finished build is already staged', () => {
    expect(stage().status).toBe(0);
    const before = gh().filter((call) => call.startsWith('gh run download')).length;
    const result = stage({}, ['--running', OLDER, '--have', HEAD_SHA]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'have', commit: HEAD_SHA });
    expect(gh().filter((call) => call.startsWith('gh run download'))).toHaveLength(before);
    expect(readFileSync(join(stageDir, DMG_NAME), 'utf8')).toBe('disk image bytes');
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(HEAD_SHA);
  });

  it('replaces the staged build with a newer one, leaving one DMG', () => {
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, 'commit'), `${OLDER}\n`);
    writeFileSync(join(stageDir, 'older.dmg'), 'older');
    const result = stage({}, ['--running', OLDER, '--have', OLDER]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'done', commit: HEAD_SHA });
    expect(existsSync(join(stageDir, 'older.dmg'))).toBe(false);
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(HEAD_SHA);
  });

  it('leaves the staged build as it is when the newer one fails its checksum', () => {
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, 'commit'), `${OLDER}\n`);
    writeFileSync(join(stageDir, 'older.dmg'), 'older');
    box.corruptChecksum();
    const result = stage({}, ['--running', OLDER, '--have', OLDER]);
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'stage', step: 'verify-checksum' });
    expect(readFileSync(join(stageDir, 'older.dmg'), 'utf8')).toBe('older');
    expect(readFileSync(join(stageDir, 'commit'), 'utf8').trim()).toBe(OLDER);
  });

  it('stages a build that is not the running one', () => {
    const result = stage({}, ['--running', OLDER]);
    expect(result.status).toBe(0);
    expect(status()).toMatchObject({ ok: true, mode: 'stage', step: 'done', commit: HEAD_SHA });
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

  it.each([
    { name: 'a running commit that is no SHA', args: ['--running', 'main'] },
    { name: '--running without a stage', args: ['--apply', '/x', '--running', HEAD_SHA] },
    { name: 'a commit to skip that is no SHA', args: ['--stage', '/x', '--skip', 'main'] },
    { name: '--skip without a stage', args: ['--apply', '/x', '--skip', HEAD_SHA] },
    { name: 'a staged commit that is no SHA', args: ['--stage', '/x', '--have', 'main'] },
    { name: '--have without a stage', args: ['--apply', '/x', '--have', HEAD_SHA] },
    { name: '--quit-first on a stage', args: ['--stage', '/x', '--quit-first'] },
    { name: 'a relative stage folder', args: ['--stage', 'staged'] },
  ])('refuses $name', ({ args }) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(box.calls()).toEqual([]);
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

  it('keeps the database backup of the install, so make rollback-app has one to name', () => {
    expect(apply().status).toBe(0);
    expect(box.list(join(box.dataDir, '..')).some((name) => name.startsWith('10db-backup-'))).toBe(
      true,
    );
  });

  it('fails at the quit step, naming it, when the app will not quit, and installs nothing', () => {
    const result = apply({ STUB_RUNNING_UNTIL_CALL: '999', TENDB_INSTALL_QUIT_SECONDS: '2' });
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'quit' });
    expect(String(status()['message'])).toContain('10db could not be quit');
    expect(String(status()['message'])).toContain('did not quit');
    expect(box.marker(app())).toBe('old build');
    expect(box.list(box.previousDir)).toEqual([]);
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

  describe('waiting for the pids it was given', () => {
    // A process pgrep does not list but whose pid the daemon knows.
    const sleepers: number[] = [];
    const startProcess = (): number => {
      // Left to init by its parent shell, so it is no zombie of this test once it is killed.
      const result = spawnSync('/bin/sh', ['-c', 'sleep 120 > /dev/null 2>&1 & echo $!'], {
        encoding: 'utf8',
      });
      const pid = Number(result.stdout.trim());
      sleepers.push(pid);
      return pid;
    };
    afterEach(() => {
      for (const pid of sleepers.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    const applyWaiting = (pid: number, env: Record<string, string> = {}) =>
      run(['--apply', stageDir, '--quit-first', '--relaunch', '--quit-pid', String(pid)], {
        TENDB_INSTALL_QUIT_POLL_SECONDS: '0.05',
        ...env,
      });

    it('installs nothing, and says 10db did not quit, while the pid lives though pgrep sees no app', () => {
      const pid = startProcess();
      const result = applyWaiting(pid, { TENDB_INSTALL_QUIT_SECONDS: '3' });
      expect(result.status).toBe(1);
      expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'quit' });
      expect(String(status()['message'])).toContain('did not quit');
      expect(String(status()['message'])).toContain(String(pid));
      expect(box.marker(app())).toBe('old build');
      expect(box.list(box.previousDir)).toEqual([]);
      // The old app is started again, as after any failure once it was asked to quit.
      expect(opened()).toEqual([`open ${app()}`]);
    });

    it('installs once the pid is gone', () => {
      const pid = startProcess();
      const result = applyWaiting(pid, {
        STUB_QUIT_KILLS: String(pid),
        TENDB_INSTALL_QUIT_SECONDS: '100',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(box.marker(app())).toBe('new build');
      expect(opened()).toEqual([`open ${app()}`]);
    });

    it('does not take a pid that was gone from the start for a running app', () => {
      const result = applyWaiting(2_000_000_000);
      expect(result.status).toBe(0);
      expect(box.marker(app())).toBe('new build');
    });

    it('signals the window instead when the quit request is refused, and waits as well', () => {
      const pid = startProcess();
      const result = applyWaiting(pid, {
        STUB_OSASCRIPT_FAILS: '1',
        TENDB_INSTALL_QUIT_SECONDS: '3',
      });
      // The stub's pkill ends nothing, so the app stays and nothing is installed.
      expect(osascripts()).toHaveLength(1);
      expect(pkills()).toHaveLength(1);
      expect(pkills()[0]).toContain('tendb-desktop');
      expect(result.status).toBe(1);
      expect(status()).toMatchObject({ ok: false, step: 'quit' });
      expect(box.marker(app())).toBe('old build');
    });

    // The self-update's script is the daemon's child and so the window's grandchild, and BSD pgrep
    // and pkill leave out their caller's ancestors unless told otherwise.
    it('signals the window that is its own ancestor, and installs once it has gone', () => {
      const pid = startProcess();
      const result = applyWaiting(pid, {
        STUB_APP_IS_ANCESTOR: '1',
        STUB_OSASCRIPT_FAILS: '1',
        STUB_SIGNAL_KILLS: String(pid),
        TENDB_INSTALL_QUIT_SECONDS: '20',
      });
      expect(result.status).toBe(0);
      expect(box.marker(app())).toBe('new build');
    });

    it('names each process once when pgrep and the daemon both list it', () => {
      const pid = startProcess();
      const result = applyWaiting(pid, {
        STUB_RUNNING: `57868 tendb-desktop\n${String(pid)} tendb-node`,
        TENDB_INSTALL_QUIT_SECONDS: '1',
      });
      expect(result.status).toBe(1);
      expect(String(status()['message'])).toContain(`process 57868 ${String(pid)})`);
    });

    it.each([
      {
        name: 'a pid that is no number',
        args: ['--apply', '/x', '--quit-first', '--quit-pid', 'abc'],
      },
      { name: 'pid 1', args: ['--apply', '/x', '--quit-first', '--quit-pid', '1'] },
      { name: '--quit-pid without --quit-first', args: ['--apply', '/x', '--quit-pid', '123'] },
      { name: '--quit-pid on a stage', args: ['--stage', '/x', '--quit-pid', '123'] },
    ])('refuses $name', ({ args }) => {
      const before = box.calls();
      const result = run(args);
      expect(result.status).toBe(2);
      expect(box.calls()).toEqual(before);
    });
  });

  it('fails at the lock step while another install holds the lock, and neither quits nor starts the app', () => {
    const lock = join(box.applications, '.10db-install.lock');
    mkdirSync(lock);
    const result = apply();
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, mode: 'apply', step: 'lock' });
    expect(String(status()['message'])).toContain('holds');
    expect(pkills()).toEqual([]);
    expect(osascripts()).toEqual([]);
    expect(opened()).toEqual([]);
    expect(box.marker(app())).toBe('old build');
    expect(existsSync(lock)).toBe(true);
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

  it('refuses a stage folder that holds no build, before it quits anything', () => {
    const result = run(['--apply', join(box.root, 'nowhere'), '--quit-first', '--relaunch']);
    expect(result.status).toBe(1);
    expect(status()).toMatchObject({ ok: false, step: 'staged-build' });
    expect(pkills()).toEqual([]);
    expect(box.marker(app())).toBe('old build');
  });
});

describe('the tools the script runs', () => {
  it('runs the gh it is handed, not the first gh on PATH', () => {
    const decoy = join(box.root, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'gh'), '#!/bin/bash\necho decoy >> "$STUB_LOG"\nexit 9\n', {
      mode: 0o755,
    });
    const result = stage({
      PATH: `${decoy}:${join(box.root, 'bin')}:/usr/bin:/bin`,
      TENDB_INSTALL_GH: join(box.root, 'bin', 'gh'),
    });
    expect(result.status).toBe(0);
    expect(box.calls().filter((call) => call.startsWith('decoy'))).toEqual([]);
    expect(gh().length).toBeGreaterThan(0);
  });
});
