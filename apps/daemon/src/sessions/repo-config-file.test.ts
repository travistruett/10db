import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { readRepoFileBytes, RepoConfigFileError } from './repo-config-file';

let dir: TempDir;

beforeEach(() => {
  dir = tempDir('repo-file');
});

afterEach(() => {
  dir.cleanup();
});

describe('readRepoFileBytes', () => {
  it('reads a binary file byte for byte with its mode', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
    const path = join(dir.path, 'x.png');
    writeFileSync(path, bytes);
    chmodSync(path, 0o751);
    const read = readRepoFileBytes(path, 1024);
    expect(read?.bytes.equals(bytes)).toBe(true);
    expect((read?.mode ?? 0) & 0o777).toBe(0o751);
  });

  it('refuses a link', () => {
    writeFileSync(join(dir.path, 'real'), 'x');
    symlinkSync(join(dir.path, 'real'), join(dir.path, 'link'));
    expect(() => readRepoFileBytes(join(dir.path, 'link'), 1024)).toThrow(
      new RepoConfigFileError('it must be a regular file, not a link'),
    );
  });

  it('refuses past the cap', () => {
    writeFileSync(join(dir.path, 'big'), 'x'.repeat(2049));
    expect(() => readRepoFileBytes(join(dir.path, 'big'), 2048)).toThrow(
      new RepoConfigFileError('it is larger than 2 KiB'),
    );
  });
});
