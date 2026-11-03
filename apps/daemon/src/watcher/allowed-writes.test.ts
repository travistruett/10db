import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type * as fs from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real filesystem, except that a test can make the file opened from `moving.path` look rewritten between
// the stat before a read and the stat after it: the real 'changing' result, with no second read to fall back
// on. `moving.watched` counts the path lookups (stat, lstat) made of one path, which must be none.
const moving = vi.hoisted(() => ({
  path: null as string | null,
  watched: null as string | null,
  stats: 0,
  opens: 0,
  pathStats: 0,
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
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  return {
    ...real,
    open: (async (path: fs.PathLike, flags: fs.OpenMode) => {
      if (path === swapped.path) {
        swapped.opens++;
        if (typeof flags !== 'number' || (flags & real.constants.O_NONBLOCK) === 0) {
          swapped.blockingOpens++;
          throw new Error('open of a FIFO would block');
        }
      }
      const handle = await real.open(path, flags);
      if (path !== moving.path) return handle;
      moving.opens++;
      // Each stat of the file reports a later modification time than the one before.
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'stat') {
            return async (options: fs.StatOptions & { bigint: true }) => {
              const stat = await target.stat(options);
              moving.stats++;
              return Object.assign(
                Object.create(Object.getPrototypeOf(stat) as object) as object,
                stat,
                { mtimeNs: stat.mtimeNs + BigInt(moving.stats) },
              );
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof fsPromises.open,
  };
});

import {
  STAMP_ATTEMPTS,
  STAMP_BUDGET_MS,
  stampMatchesExpected,
  stampOrReason,
  writeStamp,
} from './allowed-writes';

// A sparse file far too big to read within any budget here, yet small enough for every filesystem a gate runs
// on: ext4 (the CI runner's) refuses ftruncate past 16 TiB with EFBIG. At 8 TiB, even 2 GB/s takes over an hour.
const HUGE_SPARSE_BYTES = 2 ** 43;

describe('stampOrReason', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stamp-'));
    moving.path = null;
    moving.watched = null;
    moving.stats = 0;
    moving.opens = 0;
    moving.pathStats = 0;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives the stamp of a settled file', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    const result = await stampOrReason(root, 'a.txt');
    if (!('stamp' in result)) throw new Error(`no stamp: ${result.reason}`);
    expect(result.stamp).toMatch(/^\d+:5:[0-9a-f]{64}$/);
    expect(await writeStamp(root, 'a.txt')).toBe(result.stamp);
  });

  describe('stampMatchesExpected', () => {
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

    it('compares the hash the stamp holds, never the file as it is now', async () => {
      writeFileSync(join(root, 'a.txt'), 'X');
      const stamp = await writeStamp(root, 'a.txt');
      if (stamp === null) throw new Error('no stamp');
      // The file changes after it was stamped: the verdict is still about the content that was stamped.
      writeFileSync(join(root, 'a.txt'), 'Y');
      expect(stampMatchesExpected(stamp, sha('X'))).toBe(true);
      expect(stampMatchesExpected(stamp, sha('Y'))).toBe(false);
    });

    it('is false for a deletion stamp', async () => {
      const stamp = await writeStamp(root, 'gone.txt');
      if (stamp === null) throw new Error('no stamp');
      expect(stampMatchesExpected(stamp, sha(''))).toBe(false);
    });

    it('has nothing to compare for a file rewritten while it was read: it has no stamp, so it is carded', async () => {
      writeFileSync(join(root, 'busy.txt'), 'X');
      moving.path = join(root, 'busy.txt');
      const result = await stampOrReason(root, 'busy.txt');
      expect('stamp' in result).toBe(false);
    });
  });

  it('gives a deletion stamp for a path that is not there', async () => {
    const result = await stampOrReason(root, 'gone.txt');
    if (!('stamp' in result)) throw new Error(`no stamp: ${result.reason}`);
    expect(result.stamp).toMatch(/^gone:/);
  });

  it('says not-a-file for a directory', async () => {
    writeFileSync(join(root, 'f'), '');
    expect(await stampOrReason(root, '.')).toEqual({ reason: 'not-a-file' });
  });

  it('says changing for a file that kept changing while it was read, reading it STAMP_ATTEMPTS times and no more', async () => {
    writeFileSync(join(root, 'busy.txt'), 'x');
    moving.path = join(root, 'busy.txt');
    expect(await stampOrReason(root, 'busy.txt')).toEqual({ reason: 'changing' });
    expect(moving.opens).toBe(STAMP_ATTEMPTS);
    expect(await writeStamp(root, 'busy.txt')).toBeNull();
  });

  it('takes the file type and the before/after metadata from the opened descriptor, not from path lookups', async () => {
    writeFileSync(join(root, 'plain.txt'), 'hello');
    moving.watched = join(root, 'plain.txt');
    expect('stamp' in (await stampOrReason(root, 'plain.txt'))).toBe(true);
    expect(moving.pathStats).toBe(0);
  });

  describe('a large file', () => {
    const CHUNKS = 256;

    it('is hashed a chunk at a time, letting the event loop turn between chunks', async () => {
      // Sparse, so it costs no disk; reading it still hashes every byte.
      writeFileSync(join(root, 'big.bin'), '');
      truncateSync(join(root, 'big.bin'), CHUNKS * 1024 * 1024);
      let ticks = 0;
      let running = true;
      const spin = (): void => {
        if (!running) return;
        ticks++;
        setImmediate(spin);
      };
      setImmediate(spin);
      const result = await stampOrReason(root, 'big.bin');
      running = false;
      expect('stamp' in result).toBe(true);
      // One turn of the loop for each chunk read: a loop that reads synchronously after the open and the stat
      // leaves the loop no turn at all, and a handful would still be far under the chunk count.
      expect(ticks).toBeGreaterThanOrEqual(CHUNKS / 2);
    }, 60_000);
  });

  describe('a file that cannot be read in bounded time', () => {
    it('gives up on a sparse 8 TiB file once the time budget is spent, as too-large', async () => {
      writeFileSync(join(root, 'huge.bin'), '');
      truncateSync(join(root, 'huge.bin'), HUGE_SPARSE_BYTES);
      const started = performance.now();
      const result = await stampOrReason(root, 'huge.bin', 300);
      expect(result).toEqual({ reason: 'too-large' });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await writeStamp(root, 'huge.bin', 300)).toBeNull();
    }, 30_000);

    it('has a default budget that is finite and short', () => {
      expect(STAMP_BUDGET_MS).toBeGreaterThan(0);
      expect(STAMP_BUDGET_MS).toBeLessThanOrEqual(60_000);
    });

    it('reads no further than the size it started at, so a file that keeps growing is changing, not endless', async () => {
      const path = join(root, 'grow.log');
      writeFileSync(path, Buffer.alloc(8 * 1024 * 1024));
      const grower = setInterval(() => {
        appendFileSync(path, Buffer.alloc(64 * 1024));
      }, 1);
      try {
        const started = performance.now();
        const result = await stampOrReason(root, 'grow.log', 5_000);
        expect(result).toEqual({ reason: 'changing' });
        expect(performance.now() - started).toBeLessThan(5_000);
      } finally {
        clearInterval(grower);
      }
    }, 30_000);

    it('lets the event loop run while a huge file is read, so other work is never queued behind it', async () => {
      writeFileSync(join(root, 'huge.bin'), '');
      truncateSync(join(root, 'huge.bin'), HUGE_SPARSE_BYTES);
      let other = false;
      setTimeout(() => {
        other = true;
      }, 20);
      const stamping = stampOrReason(root, 'huge.bin', 500);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(other).toBe(true);
      await stamping;
    }, 30_000);
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

    it('is opened without blocking and gives not-a-file', async () => {
      const fifo = join(root, 'card.txt');
      execFileSync('mkfifo', [fifo]);
      swapped.path = fifo;
      expect(await stampOrReason(root, 'card.txt')).toEqual({ reason: 'not-a-file' });
      expect(await writeStamp(root, 'card.txt')).toBeNull();
      expect(swapped.opens).toBe(2);
      expect(swapped.blockingOpens).toBe(0);
    });
  });

  describe('a symlink is not a file', () => {
    it('gives no stamp to a link to a regular file, though the file has one', async () => {
      writeFileSync(join(root, 'target.txt'), 'hello');
      symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
      expect('stamp' in (await stampOrReason(root, 'target.txt'))).toBe(true);
      expect(await stampOrReason(root, 'link.txt')).toEqual({ reason: 'not-a-file' });
      expect(await writeStamp(root, 'link.txt')).toBeNull();
    });

    it('gives no stamp to a link to a FIFO, and never opens the FIFO', async () => {
      const fifo = join(root, 'real.fifo');
      execFileSync('mkfifo', [fifo]);
      symlinkSync(fifo, join(root, 'link.fifo'));
      expect(await stampOrReason(root, 'link.fifo')).toEqual({ reason: 'not-a-file' });
    });

    it('gives no stamp to a dangling link, not a deletion stamp either', async () => {
      symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
      expect(await stampOrReason(root, 'dangling')).toEqual({ reason: 'not-a-file' });
    });

    it('gives no stamp to a link to a directory', async () => {
      mkdirSync(join(root, 'dir'));
      symlinkSync(join(root, 'dir'), join(root, 'dirlink'));
      expect(await stampOrReason(root, 'dirlink')).toEqual({ reason: 'not-a-file' });
    });

    it('gives no stamp to a file reached through a link to a directory', async () => {
      mkdirSync(join(root, 'real'));
      writeFileSync(join(root, 'real/file.txt'), 'hello');
      symlinkSync(join(root, 'real'), join(root, 'sub'));
      expect('stamp' in (await stampOrReason(root, 'real/file.txt'))).toBe(true);
      expect(await stampOrReason(root, 'sub/file.txt')).toEqual({ reason: 'not-a-file' });
      expect(await writeStamp(root, 'sub/file.txt')).toBeNull();
    });

    it('gives no stamp through a link nested deeper, or to a file that is not there', async () => {
      mkdirSync(join(root, 'real/inner'), { recursive: true });
      mkdirSync(join(root, 'a'));
      symlinkSync(join(root, 'real'), join(root, 'a/b'));
      expect(await stampOrReason(root, 'a/b/inner/x.txt')).toEqual({ reason: 'not-a-file' });
      symlinkSync(join(root, 'nowhere'), join(root, 'dangling-dir'));
      expect(await stampOrReason(root, 'dangling-dir/x.txt')).toEqual({ reason: 'not-a-file' });
    });

    it('still stamps a file in a real directory when the checkout itself is reached through a link', async () => {
      mkdirSync(join(root, 'real'));
      writeFileSync(join(root, 'real/file.txt'), 'hello');
      const viaLink = join(root, 'checkout-link');
      symlinkSync(root, viaLink);
      expect('stamp' in (await stampOrReason(viaLink, 'real/file.txt'))).toBe(true);
    });
  });
});
