import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

const NOW = '20261029T120000Z';
const NEWEST = '20261029T034600Z';
const OLDER = '20261028T211400Z';

let box: InstalledAppSandbox;
beforeEach(() => {
  box = installedAppSandbox();
  box.writeApp(join(box.applications, `10db.app.prev-${OLDER}`), 'older build');
  box.writeApp(join(box.applications, `10db.app.prev-${NEWEST}`), 'previous build');
  // A copy saved by hand under the stamp the builder used before: hours and minutes only.
  box.writeApp(join(box.applications, '10db.app.prev-2359'), 'hand-saved build');
});
afterEach(() => {
  box.remove();
});

const rollback = (args: readonly string[] = [], env: Record<string, string> = {}) =>
  box.run('rollback-app.sh', args, { TENDB_INSTALL_STAMP: NOW, ...env });
const app = () => join(box.applications, '10db.app');
const lock = () => join(box.applications, '.10db-install.lock');
const support = () => join(box.dataDir, '..');
const backupFor = (stamp: string) => join(support(), `10db-backup-${stamp}`, '10db.sqlite');
const db = () => join(box.dataDir, '10db.sqlite');
function writeBackup(stamp: string): void {
  mkdirSync(join(support(), `10db-backup-${stamp}`));
  writeFileSync(backupFor(stamp), 'backup');
}
const rolledBack = () =>
  box.list(box.applications).filter((name) => name.startsWith('10db.app.rolled-back-'));

/** Nothing moved: the current app and the newest saved one are where they were. */
function expectNothingMoved(): void {
  expect(box.marker(app())).toBe('old build');
  expect(box.marker(join(box.applications, `10db.app.prev-${NEWEST}`))).toBe('previous build');
  expect(rolledBack()).toEqual([]);
}

describe('rollback-app.sh refusals', () => {
  it('refuses an argument', () => {
    const result = rollback([NEWEST]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: rollback-app.sh');
    expectNothingMoved();
  });

  it('refuses while 10db runs', () => {
    const result = rollback([], { STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('⌘Q');
    expectNothingMoved();
  });

  it('refuses while another install or rollback holds the lock, naming it', () => {
    mkdirSync(lock());
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(lock());
    expectNothingMoved();
    expect(box.list(box.applications)).toContain('.10db-install.lock');
  });

  it('refuses a saved app that is not a whole app bundle', () => {
    rmSync(join(box.applications, `10db.app.prev-${NEWEST}`, 'Contents', 'Info.plist'));
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Info.plist');
    expectNothingMoved();
  });

  it('refuses when install-app saved no app, naming the copies saved by hand', () => {
    for (const stamp of [OLDER, NEWEST]) {
      rmSync(join(box.applications, `10db.app.prev-${stamp}`), { recursive: true });
    }
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db.app.prev-2359');
    expect(box.marker(app())).toBe('old build');
  });

  it('refuses a TENDB_INSTALL_STAMP that is not a UTC stamp', () => {
    const result = rollback([], { TENDB_INSTALL_STAMP: 'now' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TENDB_INSTALL_STAMP');
    expectNothingMoved();
  });
});

describe('rollback-app.sh', () => {
  it('restores the newest app install-app saved, keeps the one it replaces and drops the lock', () => {
    const result = rollback();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
    expect(box.list(box.applications).filter((name) => name.startsWith('10db.app.prev-'))).toEqual([
      `10db.app.prev-${OLDER}`,
      '10db.app.prev-2359',
    ]);
    expect(rolledBack()).toEqual([`10db.app.rolled-back-${NOW}`]);
    expect(box.marker(join(box.applications, `10db.app.rolled-back-${NOW}`))).toBe('old build');
    expect(box.list(box.applications)).not.toContain('.10db-install.lock');
  });

  it('steps further back each time it runs', () => {
    expect(rollback().status).toBe(0);
    expect(rollback().status).toBe(0);
    expect(box.marker(app())).toBe('older build');
  });

  it('never overwrites an app an earlier rollback kept', () => {
    box.writeApp(join(box.applications, `10db.app.rolled-back-${NOW}`), 'kept earlier');
    const result = rollback();
    expect(result.status).toBe(0);
    expect(box.marker(join(box.applications, `10db.app.rolled-back-${NOW}`))).toBe('kept earlier');
    expect(box.marker(join(box.applications, `10db.app.rolled-back-${NOW}-2`))).toBe('old build');
  });

  it('restores when there is no current app', () => {
    rmSync(app(), { recursive: true });
    const result = rollback();
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
    expect(rolledBack()).toEqual([]);
  });

  it('prints how to back up the current database and then restore the matching backup, and runs neither', () => {
    writeBackup(NEWEST);
    writeBackup(OLDER);
    const result = rollback();
    expect(result.status).toBe(0);
    const safety = join(support(), `10db-backup-${NOW}`);
    const lines = [
      `mkdir "${safety}"`,
      `sqlite3 "${db()}" ".backup '${join(safety, '10db.sqlite')}'"`,
      `sqlite3 "${db()}" ".restore '${backupFor(NEWEST)}'"`,
    ].map((line) => result.stdout.indexOf(line));
    expect(
      lines.every((at) => at >= 0),
      String(lines),
    ).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(result.stdout).not.toContain(OLDER);
    expect(box.calls().filter((call) => call.startsWith('sqlite3 '))).toEqual([]);
  });

  it('says so when no database backup matches', () => {
    const result = rollback();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No database backup matches');
  });
});
