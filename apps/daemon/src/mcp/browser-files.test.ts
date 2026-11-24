import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskScreenId } from '@10db/contracts';
import { protectedReads } from '../sandbox';
import { openedFileIs, readUploads, UPLOAD_MAX_BYTES, writeScreenCopy } from './browser-files';

let root: string;
let copy: string;
let tempDir: string;
let outside: string;

const session = () => ({
  copy,
  tempDir,
  fileAccess: {
    checkout: copy,
    home: join(root, 'home'),
    protectedReads: protectedReads({
      home: join(root, 'home'),
      dataDir: join(root, 'home', 'data'),
      configDirs: [],
    }),
    secretFiles: [join(copy, '.env')],
    readList: [],
    configDir: join(root, 'home', '.claude'),
    providerSessionId: null,
    sandboxTemp: { roots: [join(root, 't')], own: tempDir },
  },
});

const refusal = (paths: string[]): string => {
  const result = readUploads(paths, session());
  if (!('refused' in result)) throw new Error('expected a refusal');
  return result.refused;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-upload-')));
  copy = join(root, 'work', 'repo');
  tempDir = join(root, 't', '10db-own');
  outside = join(root, 'outside');
  for (const dir of [join(copy, 'fixtures'), tempDir, outside, join(root, 'home')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(copy, 'fixtures', 'x.csv'), 'a,b\n1,2\n');
  writeFileSync(join(copy, '.env'), 'SECRET=1\n');
  writeFileSync(join(outside, 'private.txt'), 'private');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readUploads', () => {
  it('reads a relative path from the copy, not the daemon cwd', () => {
    const result = readUploads(['fixtures/x.csv'], session());
    expect(result).toEqual({
      files: [{ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') }],
    });
  });

  it('refuses a link to a file outside, and a path through a linked directory that leads outside', () => {
    symlinkSync(join(outside, 'private.txt'), join(copy, 'fixtures', 'link.txt'));
    symlinkSync(outside, join(copy, 'dir-link'));
    expect(refusal(['fixtures/link.txt'])).toContain('a link is never uploaded');
    expect(refusal(['dir-link/private.txt'])).toContain('dir-link/private.txt');
  });

  it('refuses a FIFO at once, without blocking', () => {
    execFileSync('mkfifo', [join(copy, 'pipe')]);
    expect(refusal(['pipe'])).toContain('not a regular file');
  });

  it('refuses a secret in the copy, and uploads nothing of a call that holds one', () => {
    expect(refusal(['fixtures/x.csv', '.env'])).toContain('.env');
  });

  it('refuses a call past 50 MB', () => {
    const big = join(copy, 'big.bin');
    writeFileSync(big, Buffer.alloc(0));
    // A sparse file: its size counts, its bytes are never written.
    execFileSync('truncate', ['-s', String(UPLOAD_MAX_BYTES + 1), big]);
    expect(refusal(['big.bin'])).toContain('over 50 MB');
  });
});

describe('openedFileIs', () => {
  it('refuses a descriptor of one file against the real path of another', () => {
    const a = statSync(join(copy, 'fixtures', 'x.csv'));
    expect(openedFileIs(a, join(copy, 'fixtures', 'x.csv'))).toBe(true);
    expect(openedFileIs(a, join(outside, 'private.txt'))).toBe(false);
  });
});

describe('writeScreenCopy', () => {
  const id = TaskScreenId.parse('tsc_01a20c87-d697-7423-80b5-462c2e7e5971');

  it('writes the picture, and never overwrites a planted file of the same name', () => {
    const written = writeScreenCopy(tempDir, id, Buffer.from('png'));
    expect(written).toEqual({ path: join(tempDir, '10db-screens', `${id}.png`) });
    expect(readFileSync(join(tempDir, '10db-screens', `${id}.png`), 'utf8')).toBe('png');
    expect(writeScreenCopy(tempDir, id, Buffer.from('other'))).toMatchObject({ path: null });
    expect(readFileSync(join(tempDir, '10db-screens', `${id}.png`), 'utf8')).toBe('png');
  });

  it('writes nothing through a 10db-screens that is a link to a folder outside', () => {
    symlinkSync(outside, join(tempDir, '10db-screens'));
    expect(writeScreenCopy(tempDir, id, Buffer.from('png'))).toMatchObject({ path: null });
    expect(() => statSync(join(outside, `${id}.png`))).toThrow();
  });
});
