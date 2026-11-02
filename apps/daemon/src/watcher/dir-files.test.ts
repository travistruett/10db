import { mkdirSync, mkdtempSync, opendirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Dir } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesUnderBounded, MAX_DIR_ENTRIES, MAX_DIR_FILES } from './dir-files';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dir-files-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(rel: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), 'x');
}

/** Opens directories for real and counts the entries read from them. */
function counting(): { open: (path: string) => Dir; reads: () => number } {
  let reads = 0;
  return {
    open: (path) => {
      const dir = opendirSync(path);
      return {
        readSync: () => {
          const entry = dir.readSync();
          if (entry !== null) reads += 1;
          return entry;
        },
        closeSync: () => {
          dir.closeSync();
        },
      } as Dir;
    },
    reads: () => reads,
  };
}

describe('filesUnderBounded', () => {
  it('lists files in nested directories, relative to the root', () => {
    touch('.claude/a.json');
    touch('.claude/hooks/b.sh');
    touch('.claude/hooks/deep/c.sh');
    expect(filesUnderBounded(root, '.claude')?.sort()).toEqual([
      '.claude/a.json',
      '.claude/hooks/b.sh',
      '.claude/hooks/deep/c.sh',
    ]);
  });

  it('is empty for an empty directory and null for a missing one', () => {
    mkdirSync(join(root, '.claude'));
    expect(filesUnderBounded(root, '.claude')).toEqual([]);
    expect(filesUnderBounded(root, 'nope')).toBeNull();
  });

  it('is null when the directory holds a link', () => {
    touch('.claude/a.json');
    symlinkSync(join(root, '.claude/a.json'), join(root, '.claude/link'));
    expect(filesUnderBounded(root, '.claude')).toBeNull();
  });

  it('leaves out Claude Code bookkeeping', () => {
    touch('.claude/a.json');
    touch('.claude/.cc-writes/staged');
    expect(filesUnderBounded(root, '.claude')).toEqual(['.claude/a.json']);
  });

  it('accepts exactly the most files and is null for one more', () => {
    for (let i = 0; i < 4; i += 1) touch(`d/f${String(i)}`);
    expect(filesUnderBounded(root, 'd', { maxFiles: 4 })).toHaveLength(4);
    touch('d/f4');
    expect(filesUnderBounded(root, 'd', { maxFiles: 4 })).toBeNull();
  });

  it('stops reading once past the most files, without listing the rest', () => {
    for (let i = 0; i < 200; i += 1) touch(`d/f${String(i)}`);
    const { open, reads } = counting();
    expect(filesUnderBounded(root, 'd', { maxFiles: 5, open })).toBeNull();
    expect(reads()).toBe(6);
  });

  it('stops reading once past the most entries, even when none is a file that counts', () => {
    for (let i = 0; i < 200; i += 1)
      mkdirSync(join(root, 'd', `sub${String(i)}`), { recursive: true });
    const { open, reads } = counting();
    expect(filesUnderBounded(root, 'd', { maxEntries: 10, open })).toBeNull();
    expect(reads()).toBe(11);
  });

  it('closes every directory it opened, also when it gives up', () => {
    for (let i = 0; i < 20; i += 1) touch(`d/f${String(i)}`);
    let open = 0;
    const tracked = (path: string): Dir => {
      const dir = opendirSync(path);
      open += 1;
      return {
        readSync: () => dir.readSync(),
        closeSync: () => {
          open -= 1;
          dir.closeSync();
        },
      } as Dir;
    };
    expect(filesUnderBounded(root, 'd', { maxFiles: 3, open: tracked })).toBeNull();
    expect(open).toBe(0);
  });

  it('has bounds that keep one call short', () => {
    expect(MAX_DIR_FILES).toBe(500);
    expect(MAX_DIR_ENTRIES).toBeGreaterThanOrEqual(MAX_DIR_FILES);
    expect(MAX_DIR_ENTRIES).toBeLessThanOrEqual(10_000);
  });

  it('returns within a fixed time for a directory with far more entries than the bound', () => {
    mkdirSync(join(root, 'big'));
    for (let i = 0; i < 20_000; i += 1) writeFileSync(join(root, 'big', `f${String(i)}`), '');
    const started = performance.now();
    expect(filesUnderBounded(root, 'big')).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
