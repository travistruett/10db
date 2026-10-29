import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEAD_SHA, installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

const STAMP = /^\d{8}-\d{6}$/;

let box: InstalledAppSandbox;
beforeEach(() => {
  box = installedAppSandbox();
});
afterEach(() => {
  box.remove();
});

const install = (args: readonly string[] = [], env: Record<string, string> = {}) =>
  box.run('install-app.sh', args, env);
const app = () => join(box.applications, '10db.app');
const support = () => join(box.dataDir, '..');
const backups = () => box.list(support()).filter((name) => name.startsWith('10db-backup-'));
const previous = () => box.list(box.applications).filter((name) => name.includes('.prev-'));

/** Nothing on disk changed: the old app is in place, nothing was moved aside or backed up. */
function expectUntouched(): void {
  expect(box.marker(app())).toBe('old build');
  expect(previous()).toEqual([]);
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
  ])('refuses $name with a usage line, before asking GitHub anything', ({ args }) => {
    const result = install(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: install-app.sh');
    expect(box.calls().filter((call) => call.startsWith('gh '))).toEqual([]);
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
    expect(box.calls()).toContain(`gh api repos/{owner}/{repo}/commits/${ref} --jq .sha`);
  });
});

describe('install-app.sh refusals', () => {
  it('refuses while 10db runs, tells the builder to quit it, and asks GitHub nothing', () => {
    const result = install([], { STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db is running');
    expect(result.stderr).toContain('⌘Q');
    expect(box.calls().filter((call) => call.startsWith('gh '))).toEqual([]);
    expectUntouched();
  });

  it('looks for any 10db.app process, the saved previous apps included', () => {
    install([], { STUB_RUNNING: '57868' });
    expect(box.calls()).toContain('pgrep -f /10db\\.app[^/]*/Contents/MacOS/');
  });

  it('refuses a DMG whose checksum does not match SHA256SUMS', () => {
    box.corruptChecksum();
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum');
    expectUntouched();
  });

  it('refuses when GitHub has no such ref', () => {
    const result = install(['gone'], { STUB_HEAD_SHA: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gone');
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

  it('puts the previous app back when the copy fails', () => {
    const result = install([], { STUB_DITTO_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(box.marker(app())).toBe('old build');
    expect(previous()).toEqual([]);
  });
});

describe('install-app.sh', () => {
  it('reuses the newest successful build of the head commit', () => {
    expect(install().status).toBe(0);
    const gh = box.calls().filter((call) => call.startsWith('gh '));
    expect(gh).toContain(
      `gh run list --workflow release-dry-run.yml --commit ${HEAD_SHA} --status success --limit 1 --json databaseId --jq .[0].databaseId // empty`,
    );
    expect(
      gh.some((call) => call.startsWith('gh run download 42 --name unsigned-dmg --dir ')),
    ).toBe(true);
    expect(gh.filter((call) => call.startsWith('gh workflow run'))).toEqual([]);
  });

  it.each([
    { name: 'no successful build of the commit exists', env: { STUB_SUCCESS_RUN: '' } },
    { name: "the build's artifact has expired", env: { STUB_ARTIFACT_LIVE: '0' } },
  ])('starts a build and installs it when $name', ({ env }) => {
    const result = install(['release/0.2'], env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const gh = box.calls().filter((call) => call.startsWith('gh '));
    expect(gh).toContain('gh workflow run release-dry-run.yml --ref release/0.2');
    expect(gh.some((call) => call.startsWith('gh run download 101 '))).toBe(true);
    expect(box.marker(app())).toBe('new build');
  });

  it('backs up the database beside the earlier backups, and keeps the old app under the same stamp', () => {
    const result = install();
    expect(result.status).toBe(0);
    const [backup, ...extraBackups] = backups();
    const [prev, ...extraPrevious] = previous();
    expect(extraBackups).toEqual([]);
    expect(extraPrevious).toEqual([]);
    const stamp = backup?.slice('10db-backup-'.length) ?? '';
    expect(stamp).toMatch(STAMP);
    expect(prev).toBe(`10db.app.prev-${stamp}`);
    expect(box.marker(join(box.applications, prev ?? ''))).toBe('old build');
    expect(box.list(join(support(), backup ?? ''))).toEqual(['10db.sqlite']);
    expect(box.calls()).toContain(
      `sqlite3 ${join(box.dataDir, '10db.sqlite')} .backup '${join(support(), backup ?? '', '10db.sqlite')}'`,
    );
  });

  it('installs the new app and clears quarantine on it alone', () => {
    expect(install().status).toBe(0);
    expect(box.marker(app())).toBe('new build');
    expect(box.calls().filter((call) => call.startsWith('xattr -r -d'))).toEqual([
      `xattr -r -d com.apple.quarantine ${app()}`,
    ]);
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
