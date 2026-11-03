import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_INFO_FILE, readBuildInfo } from './build-info';

const SHA = '0123456789abcdef0123456789abcdef01234567';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'build-info-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bundle(dir: string, info: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BUILD_INFO_FILE), typeof info === 'string' ? info : JSON.stringify(info));
  return dir;
}

describe('readBuildInfo', () => {
  it('is null for a run from source, which has no build-info.json', () => {
    expect(readBuildInfo(root)).toBeNull();
  });

  it.each(['not json', '{}', JSON.stringify({ commit: 'main' }), JSON.stringify([SHA])])(
    'is null for a file that does not name a commit: %s',
    (content) => {
      expect(readBuildInfo(bundle(join(root, 'a'), content))).toBeNull();
    },
  );

  it('reads the commit and the repository the build was made for', () => {
    const dir = bundle(join(root, 'a'), { commit: SHA, repository: 'o/10db' });
    expect(readBuildInfo(dir)).toEqual({
      commit: SHA,
      repository: 'o/10db',
      releaseDir: join(dir, 'release'),
      updatable: false,
    });
  });

  it('is updatable only from 10db.app in Applications, and only with a repository', () => {
    const applications = join(root, 'Applications');
    const inApp = bundle(join(applications, '10db.app', 'Contents', 'Resources', 'daemon'), {
      commit: SHA,
      repository: 'o/10db',
    });
    expect(readBuildInfo(inApp, applications)?.updatable).toBe(true);
    const noRepository = bundle(join(applications, '10db.app', 'Contents', 'Resources', 'x'), {
      commit: SHA,
    });
    expect(readBuildInfo(noRepository, applications)).toMatchObject({
      repository: null,
      updatable: false,
    });
    // A copy named like the app, and a bundle elsewhere, do not replace themselves.
    const copy = bundle(join(applications, '10db.app.old', 'Contents', 'Resources', 'daemon'), {
      commit: SHA,
      repository: 'o/10db',
    });
    expect(readBuildInfo(copy, applications)?.updatable).toBe(false);
  });

  it.each(['--upload-pack=x/y', 'owner', 'a/b/c', 'o/10db; rm', '-o/x'])(
    'takes no repository that gh could read as something else: %s',
    (repository) => {
      const dir = bundle(join(root, 'a'), { commit: SHA, repository });
      expect(readBuildInfo(dir)?.repository).toBeNull();
    },
  );
});
