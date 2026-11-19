import { describe, expect, it } from 'vitest';
import { lockedOwner, parseWorktreeList } from './worktree-list';

const SHA = 'a'.repeat(40);

/** One record as `worktree list --porcelain -z` prints it. */
const record = (...fields: string[]) => `${fields.join('\0')}\0\0`;

const rows = [
  {
    name: 'the main checkout',
    fields: ['worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main'],
    expected: { path: '/r', head: SHA, branch: 'main', locked: null, prunable: false, bare: false },
    owner: null,
  },
  {
    name: 'a 10db worktree',
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'branch refs/heads/10db/a-1', 'locked 10db bat_x'],
    expected: {
      path: '/w/a',
      head: SHA,
      branch: '10db/a-1',
      locked: '10db bat_x',
      prunable: false,
      bare: false,
    },
    owner: null,
  },
  {
    name: 'a 10db worktree with a real batch id',
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'branch refs/heads/b', 'locked 10db bat_0a1b-2c'],
    expected: {
      path: '/w/a',
      head: SHA,
      branch: 'b',
      locked: '10db bat_0a1b-2c',
      prunable: false,
      bare: false,
    },
    owner: { kind: 'batch', id: 'bat_0a1b-2c' },
  },
  {
    name: 'a 10db worktree of a chat',
    fields: ['worktree /w/c', `HEAD ${SHA}`, 'branch refs/heads/c', 'locked 10db cht_0a1b-2c'],
    expected: {
      path: '/w/c',
      head: SHA,
      branch: 'c',
      locked: '10db cht_0a1b-2c',
      prunable: false,
      bare: false,
    },
    owner: { kind: 'chat', id: 'cht_0a1b-2c' },
  },
  {
    name: 'locked with no reason',
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'branch refs/heads/b', 'locked'],
    expected: { path: '/w/a', head: SHA, branch: 'b', locked: '', prunable: false, bare: false },
    owner: null,
  },
  {
    name: 'a reason holding a newline',
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'branch refs/heads/b', 'locked 10db bat_0a\nmore'],
    expected: {
      path: '/w/a',
      head: SHA,
      branch: 'b',
      locked: '10db bat_0a\nmore',
      prunable: false,
      bare: false,
    },
    owner: null,
  },
  {
    name: 'detached',
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'detached'],
    expected: { path: '/w/a', head: SHA, branch: null, locked: null, prunable: false, bare: false },
    owner: null,
  },
  {
    name: 'bare',
    fields: ['worktree /r.git', 'bare'],
    expected: {
      path: '/r.git',
      head: null,
      branch: null,
      locked: null,
      prunable: false,
      bare: true,
    },
    owner: null,
  },
  {
    name: 'prunable',
    fields: [
      'worktree /w/gone',
      `HEAD ${SHA}`,
      'branch refs/heads/b',
      'prunable gitdir file points to non-existent location',
    ],
    expected: {
      path: '/w/gone',
      head: SHA,
      branch: 'b',
      locked: null,
      prunable: true,
      bare: false,
    },
    owner: null,
  },
  {
    name: "someone else's lock",
    fields: ['worktree /w/a', `HEAD ${SHA}`, 'branch refs/heads/b', 'locked by me'],
    expected: {
      path: '/w/a',
      head: SHA,
      branch: 'b',
      locked: 'by me',
      prunable: false,
      bare: false,
    },
    owner: null,
  },
];

describe('parseWorktreeList', () => {
  it("reads each record's fields, and the batch or chat whose 10db lock it carries", () => {
    for (const { name, fields, expected, owner } of rows) {
      const [entry, ...rest] = parseWorktreeList(record(...fields));
      expect.soft(rest, name).toEqual([]);
      expect.soft(entry, name).toEqual(expected);
      expect.soft(entry && lockedOwner(entry), name).toEqual(owner);
    }
  });

  it('reads several records in order, and nothing from empty output', () => {
    const out =
      record('worktree /r', `HEAD ${SHA}`, 'branch refs/heads/main') +
      record('worktree /w/a', `HEAD ${SHA}`, 'detached', 'locked 10db bat_1');
    expect(parseWorktreeList(out).map((e) => e.path)).toEqual(['/r', '/w/a']);
    expect(parseWorktreeList('')).toEqual([]);
  });
});
