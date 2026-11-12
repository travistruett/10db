import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collapseReads,
  setupReadRefusal,
  setupReadRoots,
  type SetupReadContext,
} from './setup-reads';

// Pure: nothing here touches the disk, so the paths are invented.
const home = '/Users/b';
const data = join(home, 'Library/Application Support/10db');
const checkout = '/work/repo';
const worktrees = '/work/10db-worktrees';
const laneTemp = '/private/tmp/10db-lanes';
const filesRoot = '/private/var/folders/x/T/10db-files';

const ctx: SetupReadContext = {
  home,
  protectedReads: [
    data,
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, '.codex'),
    join(home, '.agents'),
    join(home, 'Library/Keychains'),
    '/opt/cfg/claude',
  ],
  secretFiles: [join(checkout, '.env')],
  sandboxRoots: [laneTemp, filesRoot],
  laneWritable: [checkout, worktrees, laneTemp],
};

describe('setupReadRoots', () => {
  it('is the builder’s skill dirs and Claude Code’s plugin dir', () => {
    expect(setupReadRoots(home)).toEqual([
      join(home, '.claude/skills'),
      join(home, '.claude/plugins'),
      join(home, '.agents/skills'),
    ]);
  });
});

describe('setupReadRefusal', () => {
  it.each([
    ['a skill folder under ~/.claude/skills', join(home, '.claude/skills/s')],
    ['a skill folder under ~/.agents/skills', join(home, '.agents/skills/s')],
    ['~/.claude/skills itself', join(home, '.claude/skills')],
    [
      'a plugin install path under ~/.claude/plugins/cache',
      join(home, '.claude/plugins/cache/m/p/1'),
    ],
    [
      'a folder two levels down in the home, holding nothing protected',
      join(home, 'Projects/skills/x'),
    ],
    ['a folder outside the home holding nothing protected', '/opt/skills/x'],
  ])('opens %s', (_name, path) => {
    expect(setupReadRefusal(path, ctx)).toBeNull();
  });

  it.each([
    ['the home', home],
    ['an ancestor of the home', '/Users'],
    ['/', '/'],
    ['a top-level home folder', join(home, 'Documents')],
    ['~/.ssh', join(home, '.ssh')],
    ['~/.aws/x', join(home, '.aws/x')],
    ['~/.config/gh', join(home, '.config/gh')],
    ['~/Library/Application Support/x', join(home, 'Library/Application Support/x')],
    ['~/.claude itself', join(home, '.claude')],
    ['~/.claude/projects', join(home, '.claude/projects')],
    ['the data dir', data],
    ['a folder holding a protected config dir', '/opt/cfg'],
    ['a folder inside a protected config dir', '/opt/cfg/claude/skills'],
    ['a folder inside a checkout', join(checkout, '.claude/skills/s')],
    ['a folder that holds a checkout', '/work'],
    ['the worktree root', worktrees],
    ['a lane temp root', laneTemp],
    ['a folder holding a sandbox root', '/private/var/folders/x/T'],
    ['a checkout’s .env file', join(checkout, '.env')],
  ])('refuses %s', (_name, path) => {
    expect(setupReadRefusal(path, ctx)).toMatch(/^it /);
  });
});

describe('collapseReads', () => {
  it.each([
    ['drops a path under another', ['/a/b/c', '/a/b', '/a/b/d/e'], ['/a/b']],
    ['keeps siblings', ['/a/c', '/a/b', '/a/bb'], ['/a/b', '/a/bb', '/a/c']],
    ['deduplicates', ['/a/b', '/a/b', '/x'], ['/a/b', '/x']],
  ])('%s', (_name, paths, expected) => {
    expect(collapseReads(paths)).toEqual(expected);
  });
});
