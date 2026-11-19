import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedAppSandbox, type InstalledAppSandbox } from './installed-app-sandbox';

const NOW = '20261029T120000Z';
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
const kept = () => box.list(box.previousDir);

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
  it('refuses while 10db runs', () => {
    const result = rollback({ STUB_RUNNING: '57868' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('⌘Q');
    expectNothingMoved();
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
});
