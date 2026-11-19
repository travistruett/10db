import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

const STAMP = '20261029T101500Z';
const ZIP = `10db-${STAMP}.zip`;

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
const support = () => join(box.dataDir, '..');
const backups = () => box.list(support()).filter((name) => name.startsWith('10db-backup-'));
const kept = () => box.list(box.previousDir);
const gh = () => box.calls().filter((call) => call.startsWith('gh '));

/** The old app is in place and alone in Applications, no previous app was kept and the lock is gone. */
function expectAppUntouched(previous: readonly string[] = []): void {
  expect(box.marker(app())).toBe('old build');
  expect(box.list(box.applications)).toEqual(['10db.app']);
  expect(kept()).toEqual(previous);
}

/** As expectAppUntouched, and the database was not backed up either. */
function expectUntouched(): void {
  expectAppUntouched();
  expect(backups()).toEqual([]);
  expect(
    box.calls().filter((call) => /^(sqlite3|hdiutil|ditto|xattr|lsregister) /.test(call)),
  ).toEqual([]);
}

describe('install-app.sh refusals', () => {
  it('refuses while 10db runs, tells the builder to quit it, and asks GitHub nothing', () => {
    const result = install([], { STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db is running');
    expect(result.stderr).toContain('⌘Q');
    expect(gh()).toEqual([]);
    expectUntouched();
  });

  it('refuses a DMG whose checksum does not match SHA256SUMS', () => {
    box.corruptChecksum();
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum');
    expectUntouched();
  });

  it('refuses a build that failed, naming the run', () => {
    const result = install([], { STUB_SUCCESS_RUN: '', STUB_RUN_CONCLUSION: 'failure' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failure');
    expect(result.stderr).toContain('101');
    expectUntouched();
  });
});

describe('install-app.sh puts the previous app back', () => {
  it.each([
    { name: 'the copy fails', env: { STUB_DITTO_FAILS: '1' }, apps: ['10db.app'] },
    { name: 'the DMG will not mount', env: { STUB_ATTACH_FAILS: '1' }, apps: ['10db.app'] },
    { name: 'the DMG holds no app', env: {}, apps: [] },
    { name: 'the DMG holds two apps', env: {}, apps: ['10db.app', 'Other.app'] },
  ])('from its zip when $name, and keeps the earlier zip', ({ env, apps }) => {
    box.writeZip('10db-20261028T090000Z.zip', '10db.app', 'older build');
    box.setDmgApps(apps);
    const result = install([], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('put the previous app back');
    expectAppUntouched(['10db-20261028T090000Z.zip']);
    expect(box.zipMarker('10db-20261028T090000Z.zip')).toBe('older build');
    expect(backups()).toEqual([`10db-backup-${STAMP}`]);
  });
});

describe('install-app.sh', () => {
  it('keeps the old app as one zip outside Applications, tested before the app is removed', () => {
    const result = install();
    expect(result.status).toBe(0);
    expect(box.list(box.applications)).toEqual(['10db.app']);
    expect(box.marker(app())).toBe('new build');
    expect(kept()).toEqual([ZIP]);
    expect(box.zipMarker(ZIP)).toBe('old build');
    const zipping = box.calls().findIndex((call) => call.startsWith('ditto -c -k --keepParent '));
    const testing = box.calls().findIndex((call) => call.startsWith('unzip -tq '));
    const copying = box.calls().findIndex((call) => /^ditto \/\S*\/10db\.app /.test(call));
    expect(zipping).toBeGreaterThanOrEqual(0);
    expect([zipping, testing, copying]).toEqual(
      [...[zipping, testing, copying]].sort((a, b) => a - b),
    );
    expect(result.stdout).toContain(join(box.previousDir, ZIP));
  });
});
