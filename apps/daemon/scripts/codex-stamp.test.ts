import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../test/fixtures';
import {
  formatStamp,
  hashTree,
  parseStamp,
  readTree,
  STAMP_FILE,
  StampError,
  stampProblem,
} from './codex-stamp';

const tree = (): Map<string, Buffer> =>
  new Map([
    ['ts/A.ts', Buffer.from('a')],
    ['ts/v2/B.ts', Buffer.from('b')],
    ['fixtures/C.json', Buffer.from('[]')],
  ]);

describe('hashTree', () => {
  it('hashes the same files the same in any insertion order', () => {
    expect(hashTree(new Map([...tree()].reverse()))).toBe(hashTree(tree()));
    expect(hashTree(tree())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a changed byte', (t: Map<string, Buffer>) => t.set('ts/A.ts', Buffer.from('b'))],
    ['an added file', (t: Map<string, Buffer>) => t.set('ts/New.ts', Buffer.from(''))],
    ['a removed file', (t: Map<string, Buffer>) => t.delete('ts/A.ts')],
    [
      'a renamed file',
      (t: Map<string, Buffer>) => {
        t.set('ts/Z.ts', Buffer.from('a'));
        t.delete('ts/A.ts');
      },
    ],
  ])('changes the hash for %s', (_name, change) => {
    const changed = tree();
    change(changed);
    expect(hashTree(changed)).not.toBe(hashTree(tree()));
  });
});

describe('the stamp text', () => {
  it('round-trips formatStamp through parseStamp, and refuses a stamp with a missing line', () => {
    const stamp = { version: '0.167.0', sha256: 'a'.repeat(64) };
    expect(formatStamp(stamp)).toBe(`version=0.167.0\nsha256=${'a'.repeat(64)}\n`);
    expect(parseStamp(formatStamp(stamp))).toEqual(stamp);
    expect(() => parseStamp('version=0.167.0\n')).toThrow(StampError);
  });
});

describe('stampProblem', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = tempDir('codex-stamp');
  });
  afterEach(() => {
    dir.cleanup();
  });

  function stamped(root: string, version: string): void {
    mkdirSync(join(root, 'ts/v2'), { recursive: true });
    writeFileSync(join(root, 'ts/A.ts'), 'a');
    writeFileSync(join(root, 'ts/v2/B.ts'), 'b');
    writeFileSync(
      join(root, STAMP_FILE),
      formatStamp({ version, sha256: hashTree(readTree(root)) }),
    );
  }

  it('passes a folder whose STAMP names the pin and its hash, ignoring STAMP itself', () => {
    stamped(dir.path, '0.167.0');
    expect(stampProblem(dir.path, '0.167.0')).toBeNull();
  });

  it('fails a folder stamped for another release, naming both versions and the command', () => {
    stamped(dir.path, '0.167.0');
    expect(stampProblem(dir.path, '0.168.0')).toMatch(
      /0\.167\.0.*0\.168\.0.*pnpm --filter @10db\/daemon generate:codex/s,
    );
  });

  it.each([
    [
      'a file changed after stamping',
      (root: string) => {
        writeFileSync(join(root, 'ts/A.ts'), 'edited');
      },
      /differs.*pnpm --filter @10db\/daemon generate:codex/s,
    ],
    [
      // Finder writes one on its own; the gate on another machine never has it.
      'a stray file added after stamping',
      (root: string) => {
        writeFileSync(join(root, '.DS_Store'), 'x');
      },
      /differs.*pnpm --filter @10db\/daemon generate:codex/s,
    ],
    [
      'a symlink, which git commits as a link',
      (root: string) => {
        symlinkSync('A.ts', join(root, 'ts/Link.ts'));
      },
      /ts\/Link\.ts.*pnpm --filter @10db\/daemon generate:codex/s,
    ],
  ])('fails a folder with %s, naming the command', (_name, change, want) => {
    stamped(dir.path, '0.167.0');
    change(dir.path);
    expect(stampProblem(dir.path, '0.167.0')).toMatch(want);
  });

  it('fails a folder with no STAMP, naming the command', () => {
    writeFileSync(join(dir.path, 'A.ts'), 'a');
    expect(stampProblem(dir.path, '0.167.0')).toMatch(
      /STAMP.*pnpm --filter @10db\/daemon generate:codex/s,
    );
  });
});
