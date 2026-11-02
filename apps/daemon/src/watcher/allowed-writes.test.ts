import { execFileSync } from 'node:child_process';
import type * as fs from 'node:fs';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real filesystem, except that a test can make the file under `moving.path` look rewritten between the
// stat before a read and the stat after it: the real 'changing' result, with no second read to fall back on.
const moving = vi.hoisted(() => ({ path: null as string | null, stats: 0, opens: 0 }));
// A test can also make `swapped.path` (really a FIFO) look like the regular file at `swapped.decoy` when it is
// statted, as if the lane swapped the file for a FIFO right after the stat. An open of it that could block
// (no O_NONBLOCK) throws instead, so a regression fails rather than hanging the run.
const swapped = vi.hoisted(() => ({
  path: null as string | null,
  decoy: '',
  blockingOpens: 0,
  opens: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    openSync: ((path: fs.PathLike, flags: fs.OpenMode) => {
      if (path === moving.path) moving.opens++;
      if (path === swapped.path) {
        swapped.opens++;
        if (typeof flags !== 'number' || (flags & real.constants.O_NONBLOCK) === 0) {
          swapped.blockingOpens++;
          throw new Error('open of a FIFO would block');
        }
      }
      return real.openSync(path, flags);
    }) as typeof fs.openSync,
    statSync: ((path: fs.PathLike, options: fs.StatOptions & { bigint: true }) => {
      if (path === swapped.path) return real.statSync(swapped.decoy, options);
      const stat = real.statSync(path, options) as fs.BigIntStats;
      if (path !== moving.path) return stat;
      // Each stat of the file reports a later modification time than the one before.
      moving.stats++;
      return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as object, stat, {
        mtimeNs: stat.mtimeNs + BigInt(moving.stats),
      });
    }) as typeof fs.statSync,
  };
});

import { STAMP_ATTEMPTS, stampOrReason, writeStamp } from './allowed-writes';

describe('stampOrReason', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stamp-'));
    moving.path = null;
    moving.stats = 0;
    moving.opens = 0;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives the stamp of a settled file', () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    const result = stampOrReason(root, 'a.txt');
    if (!('stamp' in result)) throw new Error(`no stamp: ${result.reason}`);
    expect(result.stamp).toMatch(/^\d+:5:[0-9a-f]{64}$/);
    expect(writeStamp(root, 'a.txt')).toBe(result.stamp);
  });

  it('gives a deletion stamp for a path that is not there', () => {
    const result = stampOrReason(root, 'gone.txt');
    if (!('stamp' in result)) throw new Error(`no stamp: ${result.reason}`);
    expect(result.stamp).toMatch(/^gone:/);
  });

  it('says not-a-file for a directory', () => {
    writeFileSync(join(root, 'f'), '');
    expect(stampOrReason(root, '.')).toEqual({ reason: 'not-a-file' });
  });

  it('says unreadable for a dangling link', () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'link'));
    expect(stampOrReason(root, 'link')).toEqual({ reason: 'unreadable' });
  });

  it('says changing for a file that kept changing while it was read, reading it STAMP_ATTEMPTS times and no more', () => {
    writeFileSync(join(root, 'busy.txt'), 'x');
    moving.path = join(root, 'busy.txt');
    expect(stampOrReason(root, 'busy.txt')).toEqual({ reason: 'changing' });
    expect(moving.opens).toBe(STAMP_ATTEMPTS);
    expect(writeStamp(root, 'busy.txt')).toBeNull();
  });

  describe('a file swapped for a FIFO after the stat', () => {
    beforeEach(() => {
      swapped.path = null;
      swapped.blockingOpens = 0;
      swapped.opens = 0;
    });
    afterEach(() => {
      swapped.path = null;
    });

    it('opens without blocking and says not-a-file', () => {
      writeFileSync(join(root, 'decoy.txt'), 'x');
      const fifo = join(root, 'card.txt');
      execFileSync('mkfifo', [fifo]);
      swapped.path = fifo;
      swapped.decoy = join(root, 'decoy.txt');
      expect(stampOrReason(root, 'card.txt')).toEqual({ reason: 'not-a-file' });
      expect(writeStamp(root, 'card.txt')).toBeNull();
      expect(swapped.opens).toBe(2);
      expect(swapped.blockingOpens).toBe(0);
    });

    it('says not-a-file for a FIFO met with no swap, without opening it', () => {
      const fifo = join(root, 'plain.fifo');
      execFileSync('mkfifo', [fifo]);
      expect(stampOrReason(root, 'plain.fifo')).toEqual({ reason: 'not-a-file' });
    });
  });

  it('stamps a link to a file by its target content', () => {
    writeFileSync(join(root, 'target.txt'), 'hello');
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
    const direct = stampOrReason(root, 'target.txt');
    expect(stampOrReason(root, 'link.txt')).toEqual(direct);
    expect('stamp' in direct).toBe(true);
  });
});
