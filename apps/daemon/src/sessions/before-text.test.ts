import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BEFORE_TEXT_MAX_BYTES,
  readCheckoutText,
  type BeforeText,
  type CheckoutFs,
} from './before-text';

// Sessions spec §11: the daemon runs outside every sandbox and reads a path an agent named, so a
// written file's previous text is read only when it is a regular file inside the checkout, through
// one descriptor, with no second lookup of the path after a check.

let root: string;
let checkout: string;
let outside: string;

beforeEach(() => {
  // Not realpath'd: on macOS the temp directory sits behind /var -> /private/var.
  root = mkdtempSync(join(tmpdir(), 'before-text-'));
  checkout = join(root, 'repo');
  outside = join(root, 'outside');
  mkdirSync(checkout);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret'), 'SECRET');
  writeFileSync(join(outside, 'a.ts'), 'SECRET');
  writeFileSync(join(checkout, 'a.ts'), 'x\n');
  mkdirSync(join(checkout, 'src'));
  mkdirSync(join(checkout, 'd'));
  writeFileSync(join(checkout, 'd/a.ts'), 'in d\n');
  mkdirSync(join(checkout, 'd2'));
  writeFileSync(join(checkout, 'd2/a.ts'), 'in d2\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Hooks {
  /** After the `lstatSync` of a path named `a.ts` returns. */
  afterLstat?: () => void;
  /** Before the first `realpathSync`. */
  beforeRealpath?: () => void;
  /** After the first `readSync` returns. */
  afterRead?: () => void;
}

/** `node:fs`, with each hook run once at its point: the swaps an agent could race the read with. */
function swapping(hooks: Hooks): CheckoutFs {
  const once = (hook: (() => void) | undefined) => {
    let ran = false;
    return () => {
      if (ran || hook === undefined) return;
      ran = true;
      hook();
    };
  };
  const afterLstat = once(hooks.afterLstat);
  const beforeRealpath = once(hooks.beforeRealpath);
  const afterRead = once(hooks.afterRead);
  return {
    lstatSync: (path) => {
      const stats = nodeFs.lstatSync(path);
      if (basename(path) === 'a.ts') afterLstat();
      return stats;
    },
    openSync: (path, flags) => nodeFs.openSync(path, flags),
    fstatSync: (fd) => nodeFs.fstatSync(fd),
    readSync: (fd, buffer, offset, length, position) => {
      const read = nodeFs.readSync(fd, buffer, offset, length, position);
      afterRead();
      return read;
    },
    closeSync: (fd) => {
      nodeFs.closeSync(fd);
    },
    realpathSync: (path) => {
      beforeRealpath();
      return nodeFs.realpathSync.native(path);
    },
  };
}

/** Puts a link at `checkout/d` to `target`, keeping the real `d` aside. */
const linkD = (target: string) => {
  renameSync(join(checkout, 'd'), join(checkout, 'd-real'));
  symlinkSync(target, join(checkout, 'd'));
};

const restoreD = () => {
  unlinkSync(join(checkout, 'd'));
  renameSync(join(checkout, 'd-real'), join(checkout, 'd'));
};

interface Row {
  readonly name: string;
  readonly setup?: () => void;
  readonly path: () => string;
  readonly hooks?: Hooks;
  readonly expected: BeforeText;
}

const UNREAD: BeforeText = { kind: 'unread' };

const rows: readonly Row[] = [
  {
    name: 'a regular file inside',
    path: () => 'a.ts',
    expected: { kind: 'text', text: 'x\n' },
  },
  {
    name: 'the same file named by its absolute path',
    path: () => join(checkout, 'a.ts'),
    expected: { kind: 'text', text: 'x\n' },
  },
  { name: 'a missing file', path: () => 'new.ts', expected: { kind: 'absent' } },
  {
    name: 'a missing file in a missing folder',
    path: () => 'nowhere/new.ts',
    expected: { kind: 'absent' },
  },
  {
    name: 'a link inside to a file inside',
    setup: () => {
      symlinkSync(join(checkout, 'a.ts'), join(checkout, 'l.ts'));
    },
    path: () => 'l.ts',
    expected: UNREAD,
  },
  {
    name: 'a link to a file outside',
    setup: () => {
      symlinkSync(join(outside, 'secret'), join(checkout, 'l.ts'));
    },
    path: () => 'l.ts',
    expected: UNREAD,
  },
  { name: 'a path that climbs out', path: () => '../outside/secret', expected: UNREAD },
  { name: 'an absolute path outside', path: () => join(outside, 'secret'), expected: UNREAD },
  {
    name: 'a file under a linked folder that points outside',
    setup: () => {
      symlinkSync(outside, join(checkout, 'o'));
    },
    path: () => 'o/secret',
    expected: UNREAD,
  },
  {
    // The open refuses a link anywhere on the way, so a swap no path check sees is never read through.
    name: 'a file under a linked folder that points inside',
    setup: () => {
      linkD(join(checkout, 'd2'));
    },
    path: () => 'd/a.ts',
    expected: UNREAD,
  },
  {
    name: 'a hard link to a file outside',
    setup: () => {
      linkSync(join(outside, 'secret'), join(checkout, 'h.ts'));
    },
    path: () => 'h.ts',
    expected: UNREAD,
  },
  { name: 'a folder', path: () => 'src', expected: UNREAD },
  { name: 'the checkout itself', path: () => '.', expected: UNREAD },
  {
    name: 'a file over 1 MB',
    setup: () => {
      writeFileSync(join(checkout, 'big.ts'), 'x'.repeat(BEFORE_TEXT_MAX_BYTES + 1));
    },
    path: () => 'big.ts',
    expected: UNREAD,
  },
  {
    name: 'a file swapped for a link to a file outside after its lstat',
    path: () => 'a.ts',
    hooks: {
      afterLstat: () => {
        unlinkSync(join(checkout, 'a.ts'));
        symlinkSync(join(outside, 'secret'), join(checkout, 'a.ts'));
      },
    },
    expected: UNREAD,
  },
  {
    name: 'a parent folder swapped for a link outside after the lstat',
    path: () => 'd/a.ts',
    hooks: {
      afterLstat: () => {
        linkD(outside);
      },
    },
    expected: UNREAD,
  },
  {
    // Opening a FIFO for reading waits for a writer, which would stop the daemon's event loop.
    name: 'a file swapped for a FIFO after its lstat',
    path: () => 'a.ts',
    hooks: {
      afterLstat: () => {
        unlinkSync(join(checkout, 'a.ts'));
        execFileSync('/usr/bin/mkfifo', [join(checkout, 'a.ts')]);
      },
    },
    expected: UNREAD,
  },
  {
    name: 'a file replaced by another regular file after its lstat',
    path: () => 'a.ts',
    hooks: {
      afterLstat: () => {
        writeFileSync(join(checkout, 'replacement'), 'SECRET');
        renameSync(join(checkout, 'replacement'), join(checkout, 'a.ts'));
      },
    },
    expected: UNREAD,
  },
  {
    name: 'a parent linked outside before the read, then swapped back after it',
    path: () => 'd/a.ts',
    hooks: {
      beforeRealpath: () => {
        linkD(outside);
      },
      afterRead: restoreD,
    },
    expected: UNREAD,
  },
  {
    name: 'a parent whose realpath moves inside the checkout after the read',
    path: () => 'd/a.ts',
    hooks: {
      afterRead: () => {
        linkD(join(checkout, 'd2'));
      },
    },
    expected: UNREAD,
  },
];

describe('readCheckoutText', () => {
  it.each(rows)('$name', (row) => {
    row.setup?.();
    const result =
      row.hooks === undefined
        ? readCheckoutText(checkout, row.path())
        : readCheckoutText(checkout, row.path(), swapping(row.hooks));
    expect(result).toEqual(row.expected);
    expect(result.kind === 'text' && result.text.includes('SECRET')).toBe(false);
  });
});
