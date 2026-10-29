import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEAD_SHA, installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';
import { repoRoot } from './workspace';

const STAMP = '20261029T101500Z';

let box: InstalledAppSandbox;
beforeEach(() => {
  box = installedAppSandbox();
});
afterEach(() => {
  box.remove();
});

const install = (args: readonly string[] = [], env: Record<string, string> = {}) =>
  box.run('install-app.sh', args, { TENDB_INSTALL_STAMP: STAMP, ...env });
const app = () => join(box.applications, '10db.app');
const lock = () => join(box.applications, '.10db-install.lock');
const support = () => join(box.dataDir, '..');
const backups = () => box.list(support()).filter((name) => name.startsWith('10db-backup-'));
const previous = () => box.list(box.applications).filter((name) => name.includes('.prev-'));
const gh = () => box.calls().filter((call) => call.startsWith('gh '));

/** The old app is in place, nothing was moved aside and the lock is gone. */
function expectAppUntouched(): void {
  expect(box.marker(app())).toBe('old build');
  expect(previous()).toEqual([]);
  expect(box.list(box.applications)).not.toContain('.10db-install.lock');
}

/** As expectAppUntouched, and the database was not backed up either. */
function expectUntouched(): void {
  expectAppUntouched();
  expect(backups()).toEqual([]);
  expect(box.calls().filter((call) => /^(sqlite3|hdiutil|ditto|xattr) /.test(call))).toEqual([]);
}

describe('install-app.sh arguments', () => {
  it.each([
    { name: 'two refs', args: ['main', 'other'] },
    { name: 'an option', args: ['--force'] },
    { name: 'a range', args: ['main..other'] },
    { name: 'a space', args: ['my branch'] },
    { name: 'a trailing slash', args: ['release/'] },
    { name: 'a doubled slash', args: ['release//0.2'] },
    { name: 'shell characters', args: ['main;rm'] },
    { name: 'a full commit SHA', args: [HEAD_SHA] },
    { name: 'a short commit SHA', args: ['d2b6cba'] },
  ])('refuses $name with a usage line, before asking GitHub anything', ({ args }) => {
    const result = install(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: install-app.sh');
    expect(result.stderr).toContain('commit SHA');
    expect(gh()).toEqual([]);
    expectUntouched();
  });

  it.each([
    { name: 'no argument installs main', args: [], ref: 'main' },
    { name: 'an empty argument installs main', args: [''], ref: 'main' },
    { name: 'a branch with a slash', args: ['release/0.2'], ref: 'release/0.2' },
    { name: 'a tag', args: ['v0.2.0'], ref: 'v0.2.0' },
  ])('$name', ({ args, ref }) => {
    const result = install(args);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gh()).toContain(`gh api repos/{owner}/{repo}/commits/${ref} --jq .sha`);
  });
});

const hasMake = spawnSync('make', ['--version'], { encoding: 'utf8' }).status === 0;

// CI's gate image (the Playwright Ubuntu image) has no make; the builder's Mac does.
describe.skipIf(!hasMake)('the make target', () => {
  const dryRun = (args: readonly string[], env: Record<string, string> = {}) =>
    spawnSync('make', ['-n', '-s', 'install-app', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...env },
    }).stdout;

  it.each([
    { name: 'defaults to main', args: [], env: {}, ref: 'main' },
    { name: 'takes REF from the command line', args: ['REF=v0.2.0'], env: {}, ref: 'v0.2.0' },
    { name: 'ignores a REF exported by the shell', args: [], env: { REF: 'stray' }, ref: 'main' },
  ])('$name', ({ args, env, ref }) => {
    expect(dryRun(args, env)).toBe(`bash scripts/release/install-app.sh "${ref}"\n`);
  });
});

describe('install-app.sh refusals', () => {
  it('refuses while 10db runs, tells the builder to quit it, and asks GitHub nothing', () => {
    const result = install([], { STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db is running');
    expect(result.stderr).toContain('⌘Q');
    expect(gh()).toEqual([]);
    expectUntouched();
  });

  it('refuses when 10db is opened while the build downloads, before backing up', () => {
    const result = install([], { STUB_RUNNING: '57868', STUB_RUNNING_FROM_CALL: '2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db is running');
    expectUntouched();
  });

  it('refuses when 10db is opened during the backup, before moving the app', () => {
    const result = install([], { STUB_RUNNING: '57868', STUB_RUNNING_FROM_CALL: '3' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db is running');
    expectAppUntouched();
  });

  it('refuses while another install or rollback holds the lock, naming it', () => {
    mkdirSync(lock());
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(lock());
    expect(result.stderr).toContain('ls -d');
    expect(result.stderr).toContain('make rollback-app');
    expect(box.marker(app())).toBe('old build');
    expect(previous()).toEqual([]);
    expect(backups()).toEqual([]);
    expect(box.list(box.applications)).toContain('.10db-install.lock');
  });

  it('refuses a DMG whose checksum does not match SHA256SUMS', () => {
    box.corruptChecksum();
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum');
    expectUntouched();
  });

  it('says GitHub has no such ref when GitHub answers so', () => {
    const result = install(['gone'], { STUB_HEAD_SHA: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub has no branch or tag named gone');
    expectUntouched();
  });

  it('says gh could not reach GitHub when it is offline or signed out', () => {
    const result = install([], { STUB_GH_OFFLINE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not ask GitHub');
    expect(result.stderr).toContain('gh auth status');
    expect(result.stderr).not.toContain('no branch or tag');
    expectUntouched();
  });

  it('refuses a build that failed, naming the run', () => {
    const result = install([], { STUB_SUCCESS_RUN: '', STUB_RUN_CONCLUSION: 'failure' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failure');
    expect(result.stderr).toContain('101');
    expectUntouched();
  });

  it('gives up on a build still running at the deadline', () => {
    const result = install([], {
      STUB_SUCCESS_RUN: '',
      STUB_RUN_STATUS: 'in_progress',
      STUB_RUN_CONCLUSION: '',
      TENDB_INSTALL_DEADLINE_SECONDS: '0',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not finish');
    expectUntouched();
  });

  it('gives up when gh keeps failing to report on the run', () => {
    const result = install([], { STUB_VIEW_FAILS: '9' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run 42');
    expectUntouched();
  });

  it('moves nothing when sqlite3 cannot back up the database, and leaves no empty backup', () => {
    const result = install([], { STUB_SQLITE_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('back up');
    expectAppUntouched();
    expect(backups()).toEqual([]);
  });
  it('refuses a TENDB_INSTALL_STAMP that is not a UTC stamp, before anything else', () => {
    const result = install([], { TENDB_INSTALL_STAMP: '2026-10-29' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TENDB_INSTALL_STAMP');
    expect(box.calls()).toEqual([]);
    expectUntouched();
  });

  it('removes an unfinished backup when interrupted during it, and moves nothing', () => {
    const result = install([], { STUB_SQLITE_INTERRUPTS: '1' });
    expect(result.status).toBe(130);
    expect(backups()).toEqual([]);
    expectAppUntouched();
  });
});

describe('install-app.sh puts the previous app back', () => {
  it.each([
    { name: 'the copy fails', env: { STUB_DITTO_FAILS: '1' }, apps: ['10db.app'] },
    { name: 'the DMG will not mount', env: { STUB_ATTACH_FAILS: '1' }, apps: ['10db.app'] },
    { name: 'the DMG holds no app', env: {}, apps: [] },
    { name: 'the DMG holds two apps', env: {}, apps: ['10db.app', 'Other.app'] },
  ])('when $name', ({ env, apps }) => {
    box.setDmgApps(apps);
    const result = install([], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('put the previous app back');
    expectAppUntouched();
    expect(backups()).toEqual([`10db-backup-${STAMP}`]);
  });

  it.each([
    { name: 'a failed copy', env: { STUB_DITTO_FAILS: '1' }, status: 1 },
    { name: 'a Ctrl-C during the copy', env: { STUB_DITTO_INTERRUPTS: '1' }, status: 130 },
  ])(
    'finishes putting the previous app back when a Ctrl-C lands in the cleanup after $name',
    ({ env, status }) => {
      const result = install([], { ...env, STUB_DETACH_INTERRUPTS: '1' });
      expect(result.status).toBe(status);
      expect(result.stderr).toContain('put the previous app back');
      expectAppUntouched();
    },
  );

  it('detaches the DMG even when mounting it failed part way', () => {
    install([], { STUB_ATTACH_FAILS: '1' });
    expect(box.calls().some((call) => call.startsWith('hdiutil detach'))).toBe(true);
  });

  it('says loudly where the previous app is when the partial copy cannot be removed', () => {
    const result = install([], { STUB_DITTO_FAILS: 'stuck' });
    expect(result.status).toBe(1);
    const saved = join(box.applications, `10db.app.prev-${STAMP}`);
    expect(result.stderr).toContain('could not put the previous app back');
    expect(result.stderr).toContain(saved);
    expect(box.marker(saved)).toBe('old build');
    expect(box.list(app())).toEqual(['Contents']);
  });
});

describe('install-app.sh', () => {
  it('reuses the newest successful build of the head commit', () => {
    expect(install().status).toBe(0);
    expect(gh()).toContain(
      `gh run list --workflow release-dry-run.yml --commit ${HEAD_SHA} --status success --limit 1 --json databaseId --jq .[0].databaseId // empty`,
    );
    expect(gh().some((call) => call.startsWith('gh run download 42 --name unsigned-dmg '))).toBe(
      true,
    );
    expect(gh().filter((call) => call.startsWith('gh workflow run'))).toEqual([]);
  });

  it('waits for a build of the commit that is already queued or running instead of starting one', () => {
    const result = install([], { STUB_SUCCESS_RUN: '', STUB_ACTIVE_RUN: '77' });
    expect(result.status).toBe(0);
    expect(gh().filter((call) => call.startsWith('gh workflow run'))).toEqual([]);
    expect(gh().some((call) => call.startsWith('gh run download 77 '))).toBe(true);
  });

  it.each([
    { name: 'no build of the commit exists', env: { STUB_SUCCESS_RUN: '' } },
    { name: "the build's artifact has expired", env: { STUB_ARTIFACT_LIVE: '0' } },
  ])('starts a build and installs it when $name', ({ env }) => {
    const result = install(['release/0.2'], env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(gh()).toContain('gh workflow run release-dry-run.yml --ref release/0.2');
    expect(gh().some((call) => call.startsWith('gh run download 101 '))).toBe(true);
    expect(box.marker(app())).toBe('new build');
  });

  it('rides out a few failed reports on the run', () => {
    const result = install([], { STUB_VIEW_FAILS: '2' });
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('new build');
  });

  it('backs up the database beside the earlier backups, and keeps the old app under the same stamp', () => {
    const result = install();
    expect(result.status).toBe(0);
    expect(backups()).toEqual([`10db-backup-${STAMP}`]);
    expect(previous()).toEqual([`10db.app.prev-${STAMP}`]);
    expect(box.marker(join(box.applications, `10db.app.prev-${STAMP}`))).toBe('old build');
    const backup = join(support(), `10db-backup-${STAMP}`, '10db.sqlite');
    expect(box.list(join(support(), `10db-backup-${STAMP}`))).toEqual(['10db.sqlite']);
    expect(box.calls()).toContain(
      `sqlite3 ${join(box.dataDir, '10db.sqlite')} .backup '${backup}'`,
    );
  });

  it('stamps in UTC to the second when no stamp is injected', () => {
    const result = box.run('install-app.sh', []);
    expect(result.status).toBe(0);
    expect(backups()).toEqual([expect.stringMatching(/^10db-backup-\d{8}T\d{6}Z$/)]);
    expect(previous()).toEqual([`10db.app.prev-${(backups()[0] ?? '').slice(12)}`]);
  });

  it('installs the new app and clears quarantine on it alone, without following symlinks', () => {
    expect(install().status).toBe(0);
    expect(box.marker(app())).toBe('new build');
    expect(box.calls().filter((call) => call.startsWith('xattr '))).toEqual([
      `xattr -r -s -d com.apple.quarantine ${app()}`,
      `xattr -r -s -l ${app()}`,
    ]);
    expect(box.list(box.applications)).not.toContain('.10db-install.lock');
  });

  it('keeps the install when the DMG will not detach, after forcing it', () => {
    const result = install([], { STUB_DETACH_FAILS: '1' });
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('new build');
    expect(result.stderr).toContain('could not detach');
    expect(
      box.calls().some((call) => call.startsWith('hdiutil detach') && call.includes('-force')),
    ).toBe(true);
  });

  it('installs on a Mac with no 10db.app yet', () => {
    rmSync(app(), { recursive: true });
    const result = install();
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('new build');
    expect(previous()).toEqual([]);
    expect(result.stdout).not.toContain('Previous app');
  });

  it('prints the commit it installed and how to roll back', () => {
    const result = install();
    expect(result.stdout).toContain(HEAD_SHA);
    expect(result.stdout).toContain('make rollback-app');
  });

  it('installs without a backup on a Mac that has no database yet', () => {
    const result = install([], { TENDB_INSTALL_DATA_DIR: join(box.root, 'empty', '10db') });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no database');
    expect(box.marker(app())).toBe('new build');
  });
});

describe('the running check', () => {
  const pattern = spawnSync(
    '/bin/bash',
    ['-c', '. "$1"; printf %s "$app_process_pattern"', '_', 'scripts/release/installed-app.sh'],
    { cwd: repoRoot, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } },
  ).stdout;

  it.each([
    { line: '/Applications/10db.app/Contents/MacOS/tendb-desktop', running: true },
    {
      line: '/Applications/10db.app/Contents/MacOS/tendb-node /Applications/10db.app/Contents/Resources/daemon/daemon.mjs',
      running: true,
    },
    {
      line: '/Applications/10db.app.prev-20261029T101500Z/Contents/MacOS/tendb-node /Applications/10db.app.prev-20261029T101500Z/Contents/Resources/daemon/srt.mjs',
      running: true,
    },
    { line: '/Users/b/Downloads/10db.app/Contents/MacOS/tendb-desktop', running: true },
    { line: '/Applications/Other.app/Contents/MacOS/Other', running: false },
    { line: '/Applications/My10db.app/Contents/MacOS/tendb-desktop', running: false },
    { line: '/Applications/10db.application/Contents/MacOS/x', running: false },
    { line: 'vim /Applications/10db.app/Contents/Info.plist', running: false },
    { line: 'bash scripts/release/install-app.sh main', running: false },
  ])('$running for $line', ({ line, running }) => {
    expect(pattern).not.toBe('');
    const grep = spawnSync('grep', ['-E', '-q', '--', pattern], { input: line });
    expect(grep.status).toBe(running ? 0 : 1);
  });
});
