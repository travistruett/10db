import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

const NOW = '20261029T120000Z';
const LATER = '20261029T130000Z';
const PREVIOUS = '20261029T034600Z';
const ZIP = `10db-${PREVIOUS}.zip`;

let box: InstalledAppSandbox;
beforeEach(() => {
  box = installedAppSandbox();
  box.writeZip(ZIP, '10db.app', 'previous build');
});
afterEach(() => {
  box.remove();
});

const rollback = (env: Record<string, string> = {}, args: readonly string[] = []) =>
  box.run('rollback-app.sh', args, { TENDB_INSTALL_STAMP: NOW, ...env });
const app = () => join(box.applications, '10db.app');
const lock = () => join(box.applications, '.10db-install.lock');
const support = () => join(box.dataDir, '..');
const backupFor = (stamp: string) => join(support(), `10db-backup-${stamp}`, '10db.sqlite');
const db = () => join(box.dataDir, '10db.sqlite');
const kept = () => box.list(box.previousDir);
function writeBackup(stamp: string): void {
  mkdirSync(join(support(), `10db-backup-${stamp}`));
  writeFileSync(backupFor(stamp), 'backup');
}

/** Nothing moved: the current app is alone in Applications and the previous zip is as it was. */
function expectNothingMoved(): void {
  expect(box.marker(app())).toBe('old build');
  expect(box.list(box.applications).filter((name) => name !== '.10db-install.lock')).toEqual([
    '10db.app',
  ]);
  expect(kept()).toEqual([ZIP]);
  expect(box.zipMarker(ZIP)).toBe('previous build');
}

describe('rollback-app.sh refusals', () => {
  it('refuses an argument', () => {
    const result = rollback({}, [PREVIOUS]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: rollback-app.sh');
    expectNothingMoved();
  });

  it('refuses while 10db runs', () => {
    const result = rollback({ STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('⌘Q');
    expectNothingMoved();
  });

  it('refuses while another install or rollback holds the lock, naming it and leaving it', () => {
    mkdirSync(lock());
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(lock());
    expectNothingMoved();
    expect(box.list(box.applications)).toContain('.10db-install.lock');
  });

  it('refuses a TENDB_INSTALL_STAMP that is not a UTC stamp', () => {
    const result = rollback({ TENDB_INSTALL_STAMP: 'now' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TENDB_INSTALL_STAMP');
    expectNothingMoved();
  });

  it('refuses when no previous app is kept, naming where it looked', () => {
    rmSync(join(box.previousDir, ZIP));
    writeFileSync(join(box.previousDir, 'notes.zip'), 'not ours');
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(box.previousDir);
    expect(box.marker(app())).toBe('old build');
  });

  it.each([
    {
      name: 'a zip that does not test as whole',
      arrange: () => {
        writeFileSync(join(box.previousDir, ZIP), 'junk');
      },
    },
    {
      name: 'a zip whose app has no Info.plist',
      arrange: () => {
        rmSync(join(box.previousDir, ZIP));
        box.writeZip(ZIP, '10db.app', 'no bundle', { infoPlist: false });
      },
    },
  ])('refuses $name and moves nothing', ({ arrange }) => {
    arrange();
    const result = rollback();
    expect(result.status).toBe(1);
    expect(box.marker(app())).toBe('old build');
    expect(box.list(box.applications)).toEqual(['10db.app']);
    expect(kept()).toEqual([ZIP]);
  });

  it.each([
    { name: 'unpacking the previous app fails', env: { STUB_UNPACK_FAILS: '1' } },
    { name: 'zipping the current app fails', env: { STUB_ZIP_FAILS: '1' } },
    { name: 'the current app zips to a broken file', env: { STUB_ZIP_CORRUPT: '1' } },
  ])('moves nothing when $name', ({ env }) => {
    const result = rollback(env);
    expect(result.status).toBe(1);
    expectNothingMoved();
    expect(box.list(box.applications)).not.toContain('.10db-install.lock');
  });

  it('refuses a current 10db.app with no Info.plist, saying to move it aside', () => {
    rmSync(join(app(), 'Contents', 'Info.plist'));
    const result = rollback();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('move it aside');
    expect(box.marker(app())).toBe('old build');
    expect(kept()).toEqual([ZIP]);
  });

  it('puts the current app back, registered and unquarantined, when the kept app cannot be moved in', () => {
    const result = rollback({ STUB_MV_UNPACK_FAILS: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('put the current app back');
    expectNothingMoved();
    const calls = box.calls();
    const after = calls.slice(calls.findIndex((call) => call.startsWith('ditto -c -k ')));
    expect(after).toContain(`xattr -r -s -d com.apple.quarantine ${app()}`);
    expect(after).toContain(`lsregister -f -R ${app()}`);
  });
});

describe('rollback-app.sh', () => {
  it('unzips the previous app into place and keeps the replaced one as the previous zip', () => {
    const result = rollback();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
    expect(box.list(box.applications)).toEqual(['10db.app']);
    expect(kept()).toEqual([`10db-${NOW}.zip`]);
    expect(box.zipMarker(`10db-${NOW}.zip`)).toBe('old build');
  });

  it('toggles back when run twice', () => {
    expect(rollback().status).toBe(0);
    expect(rollback({ TENDB_INSTALL_STAMP: LATER }).status).toBe(0);
    expect(box.marker(app())).toBe('old build');
    expect(kept()).toEqual([`10db-${LATER}.zip`]);
    expect(box.zipMarker(`10db-${LATER}.zip`)).toBe('previous build');
  });

  it('takes the newest of several kept zips', () => {
    box.writeZip('10db-20261028T090000Z.zip', '10db.app', 'older build');
    expect(rollback().status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
  });

  it('restores a zip made by hand whose bundle has another name', () => {
    rmSync(join(box.previousDir, ZIP));
    box.writeZip('10db-20261029T171341Z.zip', '10db.app.prev-20261029T171341Z', 'hand-zipped');
    const result = rollback();
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('hand-zipped');
    expect(box.list(box.applications)).toEqual(['10db.app']);
  });

  it('registers the restored app with Launch Services and clears its quarantine', () => {
    expect(rollback().status).toBe(0);
    expect(box.calls()).toContain(`lsregister -f -R ${app()}`);
    expect(box.calls()).toContain(`xattr -r -s -d com.apple.quarantine ${app()}`);
  });

  it('restores when there is no current app, keeping the zip it restored from', () => {
    rmSync(app(), { recursive: true });
    const result = rollback();
    expect(result.status).toBe(0);
    expect(box.marker(app())).toBe('previous build');
    expect(kept()).toEqual([ZIP]);
  });

  it('prints how to back up the current database and then restore the matching backup, and runs neither', () => {
    writeBackup(PREVIOUS);
    writeBackup('20261028T211400Z');
    const result = rollback();
    expect(result.status).toBe(0);
    const safety = join(support(), `10db-backup-${NOW}`);
    const lines = [
      `mkdir "${safety}"`,
      `sqlite3 "${db()}" ".backup '${join(safety, '10db.sqlite')}'"`,
      `sqlite3 "${db()}" ".restore '${backupFor(PREVIOUS)}'"`,
    ].map((line) => result.stdout.indexOf(line));
    expect(
      lines.every((at) => at >= 0),
      String(lines),
    ).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(result.stdout).not.toContain('20261028T211400Z');
    expect(box.calls().filter((call) => call.startsWith('sqlite3 '))).toEqual([]);
  });

  it('names the safety backup with the stamp of the zip it keeps, so a toggle back finds it', () => {
    writeBackup(PREVIOUS);
    const result = rollback({ TENDB_INSTALL_STAMP: '', STUB_CLOCK: '1' });
    expect(result.status).toBe(0);
    const [zip, ...others] = kept();
    expect(others).toEqual([]);
    const stamp = (zip ?? '').replace(/^10db-|\.zip$/g, '');
    expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
    expect(result.stdout).toContain(`mkdir "${join(support(), `10db-backup-${stamp}`)}"`);
  });

  it('says so when no database backup matches', () => {
    const result = rollback();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No database backup matches');
  });
});
