import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

let box: InstalledAppSandbox;
beforeEach(() => {
  box = installedAppSandbox();
  box.writeApp(join(box.applications, '10db.app.prev-20261028-211400'), 'older build');
  box.writeApp(join(box.applications, '10db.app.prev-20261029-034600'), 'previous build');
  // A copy saved by hand under the stamp the builder used before: hours and minutes only.
  box.writeApp(join(box.applications, '10db.app.prev-2359'), 'hand-saved build');
});
afterEach(() => {
  box.remove();
});

const rollback = (args: readonly string[] = [], env: Record<string, string> = {}) =>
  box.run('rollback-app.sh', args, env);
const app = () => join(box.applications, '10db.app');
const support = () => join(box.dataDir, '..');
const backupFor = (stamp: string) => join(support(), `10db-backup-${stamp}`, '10db.sqlite');
function writeBackup(stamp: string): void {
  mkdirSync(join(support(), `10db-backup-${stamp}`));
  writeFileSync(backupFor(stamp), 'backup');
}

describe('rollback-app.sh', () => {
  it('refuses an argument', () => {
    const result = rollback(['20261029-034600']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: rollback-app.sh');
    expect(box.marker(app())).toBe('old build');
  });

  it('refuses while 10db runs and moves nothing', () => {
    const result = rollback([], { STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('⌘Q');
    expect(box.marker(app())).toBe('old build');
    expect(box.marker(join(box.applications, '10db.app.prev-20261029-034600'))).toBe(
      'previous build',
    );
  });

  it('restores the newest app install-app saved and keeps the one it replaces', () => {
    const result = rollback();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
    const entries = box.list(box.applications);
    expect(entries.filter((name) => name.startsWith('10db.app.prev-'))).toEqual([
      '10db.app.prev-20261028-211400',
      '10db.app.prev-2359',
    ]);
    const kept = entries.filter((name) => name.startsWith('10db.app.rolled-back-'));
    expect(kept).toHaveLength(1);
    expect(box.marker(join(box.applications, kept[0] ?? ''))).toBe('old build');
  });

  it('prints the command that restores the matching database backup, and runs nothing on the database', () => {
    writeBackup('20261029-034600');
    writeBackup('20261028-211400');
    const result = rollback();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `sqlite3 "${join(box.dataDir, '10db.sqlite')}" ".restore '${backupFor('20261029-034600')}'"`,
    );
    expect(result.stdout).not.toContain('20261028-211400');
    expect(box.calls().filter((call) => call.startsWith('sqlite3 '))).toEqual([]);
  });

  it('says so when no database backup matches', () => {
    const result = rollback();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No database backup matches');
  });

  it('refuses when install-app saved no app, naming the copies saved by hand', () => {
    box.remove();
    box = installedAppSandbox();
    box.writeApp(join(box.applications, '10db.app.prev-2359'), 'hand-saved build');
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('10db.app.prev-2359');
    expect(box.marker(app())).toBe('old build');
  });
});
