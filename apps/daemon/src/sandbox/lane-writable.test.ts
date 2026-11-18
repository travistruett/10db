import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { LaneWritableKind, laneWritableRoots, underLaneWritable } from './lane-writable';

let root: TempDir;
let base: string;
let home: string;
let checkout: string;
let worktrees: string;
let lanes: string;

beforeEach(() => {
  root = homeOutsideTemp('lane-writable');
  base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  worktrees = join(base, 'worktrees');
  lanes = join(base, 'lanes');
  for (const dir of [home, checkout, worktrees, lanes]) mkdirSync(dir);
});

afterEach(() => {
  root.cleanup();
});

const roots = () =>
  laneWritableRoots({
    checkouts: [checkout],
    worktreeBase: worktrees,
    sandboxTempRoots: [lanes],
    systemTempRoots: ['/private/tmp', '/private/var/tmp'],
  });

describe('laneWritableRoots', () => {
  it('lists every checkout, the worktree base, the lane temp roots and the system temp roots', () => {
    const paths = roots().map((r) => [r.path, r.kind]);
    expect(paths).toEqual(
      expect.arrayContaining([
        [checkout, LaneWritableKind.Project],
        [worktrees, LaneWritableKind.Worktrees],
        [lanes, LaneWritableKind.Temp],
        ['/private/tmp', LaneWritableKind.Temp],
        ['/private/var/tmp', LaneWritableKind.Temp],
        ['/tmp', LaneWritableKind.Temp],
        ['/var/tmp', LaneWritableKind.Temp],
      ]),
    );
  });
});

describe('underLaneWritable', () => {
  it('names the lane-writable root a path lies under by its real path, or none', () => {
    const rows: [string, () => string, () => string, LaneWritableKind | null][] = [
      [
        'a worktree made after the list was built is under the base',
        () => {
          mkdirSync(join(worktrees, 'later'));
          return join(worktrees, 'later', 'x');
        },
        () => home,
        LaneWritableKind.Worktrees,
      ],
      [
        'a path that doesn’t exist yet in a checkout is under it',
        () => join(checkout, 'dist', 'server.js'),
        () => home,
        LaneWritableKind.Project,
      ],
      [
        'a path whose existing ancestor links into a checkout is under it',
        () => {
          symlinkSync(checkout, join(home, 'work'));
          return join(home, 'work', 'not-yet', 'x.js');
        },
        () => home,
        LaneWritableKind.Project,
      ],
      [
        'a dangling link into a checkout is judged by its target',
        () => {
          symlinkSync(join(checkout, 'not-yet.js'), join(home, 'dangling'));
          return join(home, 'dangling');
        },
        () => home,
        LaneWritableKind.Project,
      ],
      [
        'a dangling relative link into a checkout is judged by its target',
        () => {
          symlinkSync('../checkout/not-yet.js', join(home, 'dangling-relative'));
          return join(home, 'dangling-relative');
        },
        () => home,
        LaneWritableKind.Project,
      ],
      [
        'a relative path is judged against its base',
        () => 'dist/x.js',
        () => checkout,
        LaneWritableKind.Project,
      ],
      ['/tmp is a temp folder', () => '/tmp/x', () => home, LaneWritableKind.Temp],
      ['a path in the home is under none', () => join(home, 'bin', 'tool'), () => home, null],
    ];
    const list = roots();
    for (const [name, path, at, kind] of rows) {
      const made = path();
      expect.soft(underLaneWritable(made, list, at()), `${name}: ${made}`).toBe(kind);
    }
  });
});
