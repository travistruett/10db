import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDeletionStamp,
  unstampedReason,
  writeStamp,
  type UnstampedReason,
} from './allowed-writes';

// The race: a path is a regular file when the stamp looks, and a FIFO by the time it is opened. The
// swap happens inside the open, the only place a plain open of a FIFO would block for ever.
const race = vi.hoisted(() => ({ swapToFifo: null as ((path: string) => void) | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const open = ((path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
    const swap = race.swapToFifo;
    race.swapToFifo = null;
    if (swap) swap(String(path));
    return (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(path, ...rest);
  }) as typeof real.open;
  return { ...real, default: { ...real, open }, open };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stamp-'));
});

afterEach(() => {
  race.swapToFifo = null;
  rmSync(root, { recursive: true, force: true });
});

describe('writeStamp', () => {
  it('stamps a regular file with its modification time, size and content hash', async () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'hello\n');
    const { mtimeNs } = statSync(path, { bigint: true });
    const hash = createHash('sha256').update('hello\n').digest('hex');
    expect(await writeStamp(root, 'a.txt')).toBe(`${String(mtimeNs)}:6:${hash}`);
  });

  it('gives a missing file a deletion stamp', async () => {
    const stamp = await writeStamp(root, 'gone.txt');
    expect(stamp !== null && isDeletionStamp(stamp)).toBe(true);
  });

  it('gives a directory no stamp', async () => {
    execFileSync('mkdir', [join(root, 'dir')]);
    expect(await writeStamp(root, 'dir')).toBeNull();
  });

  it('gives a FIFO no stamp without opening it for a writer', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(await writeStamp(root, 'pipe')).toBeNull();
  });

  it('gives a path swapped for a FIFO between the check and the open no stamp, and never blocks', async () => {
    const path = join(root, 'swapped');
    writeFileSync(path, 'was a file\n');
    race.swapToFifo = (target) => {
      rmSync(target);
      execFileSync('mkfifo', [target]);
    };
    expect(await writeStamp(root, 'swapped')).toBeNull();
  });

  it('does not follow a symlink to a regular file', async () => {
    writeFileSync(join(root, 'target.txt'), 'secret\n');
    symlinkSync(join(root, 'target.txt'), join(root, 'link'));
    expect(await writeStamp(root, 'link')).toBeNull();
  });

  it('does not follow a symlink to a FIFO', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    symlinkSync(join(root, 'pipe'), join(root, 'link'));
    expect(await writeStamp(root, 'link')).toBeNull();
  });

  it('does not follow a dangling symlink', async () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'link'));
    expect(await writeStamp(root, 'link')).toBeNull();
  });

  it('lets the event loop run while it hashes a very large file', async () => {
    const path = join(root, 'big.bin');
    writeFileSync(path, '');
    truncateSync(path, 256 * 1024 * 1024);
    let ticks = 0;
    let hashing = true;
    const spin = (): void => {
      if (!hashing) return;
      ticks += 1;
      setImmediate(spin);
    };
    setImmediate(spin);
    const stamp = await writeStamp(root, 'big.bin');
    hashing = false;
    expect(stamp).toMatch(/^\d+:268435456:[0-9a-f]{64}$/);
    expect(ticks).toBeGreaterThan(1);
  });
});

describe('unstampedReason', () => {
  const rows: readonly {
    readonly name: string;
    readonly arrange: () => string;
    readonly reason: UnstampedReason;
  }[] = [
    {
      name: 'a directory is not a file',
      arrange: () => {
        execFileSync('mkdir', [join(root, 'dir')]);
        return 'dir';
      },
      reason: 'not-a-file',
    },
    {
      name: 'a FIFO is not a file',
      arrange: () => {
        execFileSync('mkfifo', [join(root, 'pipe')]);
        return 'pipe';
      },
      reason: 'not-a-file',
    },
    {
      name: 'a path swapped for a FIFO before the open is not a file',
      arrange: () => {
        writeFileSync(join(root, 'swapped'), 'was a file\n');
        race.swapToFifo = (target) => {
          rmSync(target);
          execFileSync('mkfifo', [target]);
        };
        return 'swapped';
      },
      reason: 'not-a-file',
    },
    {
      name: 'a symlink to a regular file is not a file',
      arrange: () => {
        writeFileSync(join(root, 'target.txt'), 'secret\n');
        symlinkSync(join(root, 'target.txt'), join(root, 'link'));
        return 'link';
      },
      reason: 'not-a-file',
    },
    {
      name: 'a dangling symlink is not a file',
      arrange: () => {
        symlinkSync(join(root, 'nowhere'), join(root, 'link'));
        return 'link';
      },
      reason: 'not-a-file',
    },
    {
      name: 'a file that cannot be opened is unreadable',
      arrange: () => {
        writeFileSync(join(root, 'locked.txt'), 'locked\n');
        chmodSync(join(root, 'locked.txt'), 0o000);
        return 'locked.txt';
      },
      reason: 'unreadable',
    },
    {
      name: 'a regular file that stamps now was changing',
      arrange: () => {
        writeFileSync(join(root, 'a.txt'), 'hello\n');
        return 'a.txt';
      },
      reason: 'changing',
    },
  ];

  it.each(rows)('$name', async ({ arrange, reason }) => {
    expect(await unstampedReason(root, arrange())).toBe(reason);
  });
});
