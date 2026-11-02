import { execFileSync } from 'node:child_process';
import type * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real filesystem, except that a test can make the file opened from `moving.path` look rewritten between
// the fstat before a read and the fstat after it: the real 'changing' result, with no second read to fall back
// on. `moving.watched` counts the path lookups (stat, lstat) made of one path, which must be none.
const moving = vi.hoisted(() => ({
  path: null as string | null,
  watched: null as string | null,
  stats: 0,
  opens: 0,
  pathStats: 0,
  fds: new Set<number>(),
}));
// A test can also watch `swapped.path` (really a FIFO): an open of it that could block (no O_NONBLOCK) throws
// instead, so a regression fails rather than hanging the run.
const swapped = vi.hoisted(() => ({
  path: null as string | null,
  blockingOpens: 0,
  opens: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    openSync: ((path: fs.PathLike, flags: fs.OpenMode) => {
      if (path === swapped.path) {
        swapped.opens++;
        if (typeof flags !== 'number' || (flags & real.constants.O_NONBLOCK) === 0) {
          swapped.blockingOpens++;
          throw new Error('open of a FIFO would block');
        }
      }
      const fd = real.openSync(path, flags);
      if (path === moving.path) {
        moving.opens++;
        moving.fds.add(fd);
      }
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd: number) => {
      moving.fds.delete(fd);
      real.closeSync(fd);
    }) as typeof fs.closeSync,
    fstatSync: ((fd: number, options: fs.StatOptions & { bigint: true }) => {
      const stat = real.fstatSync(fd, options);
      if (!moving.fds.has(fd)) return stat;
      // Each fstat of the file reports a later modification time than the one before.
      moving.stats++;
      return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as object, stat, {
        mtimeNs: stat.mtimeNs + BigInt(moving.stats),
      });
    }) as typeof fs.fstatSync,
    statSync: ((path: fs.PathLike, options: fs.StatOptions) => {
      if (path === moving.watched) moving.pathStats++;
      return real.statSync(path, options);
    }) as typeof fs.statSync,
    lstatSync: ((path: fs.PathLike, options: fs.StatOptions) => {
      if (path === moving.watched) moving.pathStats++;
      return real.lstatSync(path, options);
    }) as typeof fs.lstatSync,
  };
});

import { STAMP_ATTEMPTS, stampOrReason, writeStamp } from './allowed-writes';

describe('stampOrReason', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stamp-'));
    moving.path = null;
    moving.watched = null;
    moving.stats = 0;
    moving.opens = 0;
    moving.pathStats = 0;
    moving.fds.clear();
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

  it('says changing for a file that kept changing while it was read, reading it STAMP_ATTEMPTS times and no more', () => {
    writeFileSync(join(root, 'busy.txt'), 'x');
    moving.path = join(root, 'busy.txt');
    expect(stampOrReason(root, 'busy.txt')).toEqual({ reason: 'changing' });
    expect(moving.opens).toBe(STAMP_ATTEMPTS);
    expect(writeStamp(root, 'busy.txt')).toBeNull();
  });

  it('takes the file type and the before/after metadata from the opened descriptor, not from path lookups', () => {
    writeFileSync(join(root, 'plain.txt'), 'hello');
    moving.watched = join(root, 'plain.txt');
    expect('stamp' in stampOrReason(root, 'plain.txt')).toBe(true);
    expect(moving.pathStats).toBe(0);
  });

  describe('a FIFO at the path', () => {
    beforeEach(() => {
      swapped.path = null;
      swapped.blockingOpens = 0;
      swapped.opens = 0;
    });
    afterEach(() => {
      swapped.path = null;
    });

    it('is opened without blocking and gives not-a-file', () => {
      const fifo = join(root, 'card.txt');
      execFileSync('mkfifo', [fifo]);
      swapped.path = fifo;
      expect(stampOrReason(root, 'card.txt')).toEqual({ reason: 'not-a-file' });
      expect(writeStamp(root, 'card.txt')).toBeNull();
      expect(swapped.opens).toBe(2);
      expect(swapped.blockingOpens).toBe(0);
    });
  });

  describe('a symlink is not a file', () => {
    it('gives no stamp to a link to a regular file, though the file has one', () => {
      writeFileSync(join(root, 'target.txt'), 'hello');
      symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
      expect('stamp' in stampOrReason(root, 'target.txt')).toBe(true);
      expect(stampOrReason(root, 'link.txt')).toEqual({ reason: 'not-a-file' });
      expect(writeStamp(root, 'link.txt')).toBeNull();
    });

    it('gives no stamp to a link to a FIFO, and never opens the FIFO', () => {
      const fifo = join(root, 'real.fifo');
      execFileSync('mkfifo', [fifo]);
      symlinkSync(fifo, join(root, 'link.fifo'));
      expect(stampOrReason(root, 'link.fifo')).toEqual({ reason: 'not-a-file' });
    });

    it('gives no stamp to a dangling link, not a deletion stamp either', () => {
      symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
      expect(stampOrReason(root, 'dangling')).toEqual({ reason: 'not-a-file' });
    });

    it('gives no stamp to a link to a directory', () => {
      mkdirSync(join(root, 'dir'));
      symlinkSync(join(root, 'dir'), join(root, 'dirlink'));
      expect(stampOrReason(root, 'dirlink')).toEqual({ reason: 'not-a-file' });
    });
  });
});
