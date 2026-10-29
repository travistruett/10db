import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  assertWorktreeRootAllowed,
  checkoutConflictsWithRoot,
  worktreeRootFor,
  WorktreeRootError,
} from './worktree-root';

let tmp: ReturnType<typeof tempDir>;
let base: string;
beforeEach(() => {
  tmp = tempDir('wtroot');
  base = realpathSync(tmp.path);
});
afterEach(() => {
  tmp.cleanup();
});

function made(...parts: string[]): string {
  const path = join(base, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('assertWorktreeRootAllowed', () => {
  const rows: {
    name: string;
    root: (ctx: { repo: string; data: string; tempRoot: string }) => string;
    ok: boolean;
  }[] = [
    { name: 'a root outside everything', root: () => join(base, 'wt', 'abcd1234'), ok: true },
    {
      name: 'inside a registered checkout',
      root: (c) => join(c.repo, '.wt', 'abcd1234'),
      ok: false,
    },
    { name: 'the checkout itself', root: (c) => c.repo, ok: false },
    { name: 'the data dir itself', root: (c) => c.data, ok: false },
    { name: 'under the data dir', root: (c) => join(c.data, 'wt'), ok: false },
    { name: 'under the lane temp root', root: (c) => join(c.tempRoot, 'wt'), ok: false },
    {
      name: 'reached through a link into a checkout',
      root: () => join(base, 'link-to-repo', 'wt'),
      ok: false,
    },
    {
      name: 'not created yet, under a checkout',
      root: (c) => join(c.repo, 'a', 'b', 'c'),
      ok: false,
    },
    { name: 'under a file', root: () => join(base, 'a-file', 'abcd1234'), ok: false },
    {
      name: 'a sibling that shares a name prefix',
      root: () => join(base, 'repo-two', 'wt'),
      ok: true,
    },
  ];

  it.each(rows)('$name', ({ root, ok }) => {
    const repo = made('repo');
    const data = made('data');
    const tempRoot = made('lane-tmp');
    made('repo-two');
    writeFileSync(join(base, 'a-file'), '');
    symlinkSync(repo, join(base, 'link-to-repo'));
    const call = (): void => {
      assertWorktreeRootAllowed(root({ repo, data, tempRoot }), {
        checkouts: [repo],
        dataDir: data,
        tempRoot,
      });
    };
    if (ok) expect(call).not.toThrow();
    else expect(call).toThrow(WorktreeRootError);
  });

  it('names the kind of place and both paths', () => {
    const repo = made('repo');
    const root = join(repo, 'wt');
    expect(() => {
      assertWorktreeRootAllowed(root, { checkouts: [repo], dataDir: made('data'), tempRoot: null });
    }).toThrow(new RegExp(`checkout.*${repo}`));
  });

  it('accepts a root when there is no sandbox temp root', () => {
    expect(() => {
      assertWorktreeRootAllowed(join(base, 'wt'), {
        checkouts: [],
        dataDir: made('data'),
        tempRoot: null,
      });
    }).not.toThrow();
  });
});

describe('checkoutConflictsWithRoot', () => {
  it.each([
    ['a checkout the root lies under', (root: string) => join(root, '..'), true],
    ['a checkout at the root', (root: string) => root, true],
    ['a checkout under the root', (root: string) => join(root, 'x', 'y'), true],
    ['an unrelated checkout', () => join(base, 'elsewhere'), false],
  ])('%s', (_name, checkout, conflicts) => {
    const root = made('wt', 'abcd1234');
    made('elsewhere');
    mkdirSync(join(root, 'x', 'y'), { recursive: true });
    expect(checkoutConflictsWithRoot(root, checkout(root))).toBe(conflicts);
  });

  it('sees a checkout reached through a link into the root', () => {
    const root = made('wt', 'abcd1234');
    symlinkSync(root, join(base, 'alias'));
    expect(checkoutConflictsWithRoot(root, join(base, 'alias'))).toBe(true);
  });
});

describe('worktreeRootFor', () => {
  it('gives each data dir its own level under the base', () => {
    const a = made('data-a');
    const b = made('data-b');
    const rootA = worktreeRootFor(join(base, 'wt'), a);
    expect(rootA).toMatch(new RegExp(`^${join(base, 'wt')}/[0-9a-f]{8}$`));
    expect(worktreeRootFor(join(base, 'wt'), b)).not.toBe(rootA);
  });

  it("hashes the data dir's real path", () => {
    const a = made('data-a');
    symlinkSync(a, join(base, 'data-link'));
    expect(worktreeRootFor(join(base, 'wt'), join(base, 'data-link'))).toBe(
      worktreeRootFor(join(base, 'wt'), a),
    );
  });

  it.each<{ name: string; base: () => string }>([
    {
      name: 'a base reached through a link to a place under a file',
      base: () => {
        writeFileSync(join(base, 'a-file'), '');
        symlinkSync(join(base, 'a-file', 'x'), join(base, 'link'));
        return join(base, 'link', 'wt');
      },
    },
    {
      name: 'a base through a link to itself',
      base: () => {
        symlinkSync(join(base, 'loop'), join(base, 'loop'));
        return join(base, 'loop', 'wt');
      },
    },
  ])('refuses $name as a worktree root error', ({ base: at }) => {
    expect(() => worktreeRootFor(at(), made('data'))).toThrow(WorktreeRootError);
  });

  it('returns a real path even when the base is reached through a link', () => {
    const real = made('real-base');
    symlinkSync(real, join(base, 'base-link'));
    const root = worktreeRootFor(join(base, 'base-link', 'not', 'yet'), made('data'));
    expect(root.startsWith(join(real, 'not', 'yet'))).toBe(true);
  });
});
