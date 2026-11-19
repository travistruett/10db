import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import {
  bookkeepingAt,
  CLAUDE_CODE_BOOKKEEPING,
  ignoredBookkeepingWrite,
  isInsideClaudeCodeBookkeeping,
} from './claude-code-bookkeeping';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('bookkeeping');
});
afterEach(() => {
  dir.cleanup();
});

const lock = '.claude/scheduled_tasks.lock';

/** A copy of its own under the temp dir, so each row of a folded table starts empty. */
const copy = (name: string): string => {
  const path = join(dir.path, name);
  mkdirSync(path);
  return path;
};

describe('the Claude Code bookkeeping list', () => {
  it('names the Claude Code behaviour that writes each entry, and holds no path that changes what a session may do', () => {
    expect(CLAUDE_CODE_BOOKKEEPING.length).toBeGreaterThan(0);
    const risky = /settings|hooks|agents|skills|commands|\.mcp|CLAUDE\.md/;
    for (const entry of CLAUDE_CODE_BOOKKEEPING) {
      expect.soft(entry.path).toMatch(/^\.claude\//);
      expect.soft(entry.writtenBy.length, entry.path).toBeGreaterThan(20);
      expect.soft(entry.path).not.toMatch(risky);
    }
  });
});

describe('ignoredBookkeepingWrite', () => {
  it('ignores the scheduled-tasks lock as a file and when it is gone', () => {
    mkdirSync(join(dir.path, '.claude'));
    expect(ignoredBookkeepingWrite(dir.path, lock)?.path).toBe(lock);
    writeFileSync(join(dir.path, lock), '{}');
    expect(ignoredBookkeepingWrite(dir.path, lock)).not.toBeNull();
  });

  it('does not ignore the lock as a link, a hard link to another file or a directory, nor any other path', () => {
    const ROWS: readonly { name: string; arrange: (root: string) => void }[] = [
      {
        name: 'a link',
        arrange: (root) => {
          mkdirSync(join(root, '.claude'));
          symlinkSync(join(root, 'elsewhere'), join(root, lock));
        },
      },
      {
        name: 'a hard link to another file',
        arrange: (root) => {
          mkdirSync(join(root, '.claude'));
          writeFileSync(join(root, '.claude/settings.local.json'), '{}');
          linkSync(join(root, '.claude/settings.local.json'), join(root, lock));
        },
      },
      {
        name: 'a directory',
        arrange: (root) => {
          mkdirSync(join(root, lock), { recursive: true });
        },
      },
    ];
    for (const [i, { name, arrange }] of ROWS.entries()) {
      const root = copy(`row-${String(i)}`);
      arrange(root);
      expect.soft(ignoredBookkeepingWrite(root, lock), name).toBeNull();
    }
    for (const rel of [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/pre.sh',
      '.claude/agents/a.md',
      '.claude/skills/s/SKILL.md',
      '.claude/x/scheduled_tasks.lock',
      '.claude/scheduled_tasks.lockx',
      'scheduled_tasks.lock',
      '.claude/scheduled_tasks.json',
    ])
      expect.soft(ignoredBookkeepingWrite(dir.path, rel), rel).toBeNull();
  });
});

describe('bookkeepingAt', () => {
  const pathsIn = (root: string) => (rel: string) => bookkeepingAt(root, rel).map((e) => e.path);

  it('names the entries a .claude holding only bookkeeping holds, nested anywhere in the copy', () => {
    const top = copy('top');
    const paths = pathsIn(top);
    mkdirSync(join(top, '.claude/.cc-writes'), { recursive: true });
    writeFileSync(join(top, lock), '{}');
    expect(paths('.claude').sort()).toEqual(['.claude/.cc-writes', lock]);
    expect(paths('.claude/.cc-writes')).toEqual(['.claude/.cc-writes']);
    expect(paths('.claude/.cc-writes/x.tmp')).toEqual(['.claude/.cc-writes']);

    const deep = pathsIn(copy('nested'));
    const nested = '.claude/hooks/.claude';
    mkdirSync(join(dir.path, 'nested', nested, '.cc-writes'), { recursive: true });
    writeFileSync(join(dir.path, 'nested', nested, 'scheduled_tasks.lock'), '{}');
    // The entries are the list's, whichever folder they were found in.
    expect(deep(nested).sort()).toEqual(['.claude/.cc-writes', lock]);
    expect(deep(`${nested}/.cc-writes`)).toEqual(['.claude/.cc-writes']);
    expect(deep(`${nested}/.cc-writes/x.tmp`)).toEqual(['.claude/.cc-writes']);
    expect(deep(`${nested}/scheduled_tasks.lock`)).toEqual([lock]);
    expect(isInsideClaudeCodeBookkeeping(`${nested}/.cc-writes/x.tmp`)).toBe(true);
    expect(isInsideClaudeCodeBookkeeping(`${nested}/.cc-writes`)).toBe(false);
    expect(isInsideClaudeCodeBookkeeping('src/.claude/.cc-writes/x')).toBe(true);
  });

  it('gives none for a lock that is a link, a .claude that also holds a real file, a path that only looks alike, or an empty .claude', () => {
    const nested = '.claude/hooks/.claude';
    const ROWS: readonly {
      name: string;
      arrange: (root: string) => void;
      rels: readonly string[];
    }[] = [
      {
        name: 'a lock that is a hard link to the settings',
        arrange: (root) => {
          mkdirSync(join(root, '.claude'));
          writeFileSync(join(root, '.claude/settings.local.json'), '{}');
          linkSync(join(root, '.claude/settings.local.json'), join(root, lock));
        },
        rels: [lock, '.claude'],
      },
      {
        name: 'a nested .claude that also holds a real file',
        arrange: (root) => {
          mkdirSync(join(root, nested, '.cc-writes'), { recursive: true });
          writeFileSync(join(root, nested, 'settings.json'), '{}');
        },
        rels: [nested, `${nested}/settings.json`],
      },
      {
        name: 'a nested lock that is a link, or a path that only looks alike',
        arrange: (root) => {
          mkdirSync(join(root, nested), { recursive: true });
          symlinkSync(join(root, 'elsewhere'), join(root, nested, 'scheduled_tasks.lock'));
        },
        rels: [
          `${nested}/scheduled_tasks.lock`,
          '.claude/hooks/.cc-writes/x',
          '.claude/hooks/scheduled_tasks.lock',
        ],
      },
      {
        name: 'an empty .claude or another directory',
        arrange: (root) => {
          mkdirSync(join(root, '.claude'));
          mkdirSync(join(root, 'src/.cc-writes'), { recursive: true });
        },
        rels: ['.claude', 'src'],
      },
    ];
    for (const [i, { name, arrange, rels }] of ROWS.entries()) {
      const root = copy(`row-${String(i)}`);
      arrange(root);
      for (const rel of rels) expect.soft(pathsIn(root)(rel), `${name}: ${rel}`).toEqual([]);
    }
  });
});
