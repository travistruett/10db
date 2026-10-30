import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { CLAUDE_CODE_BOOKKEEPING, ignoredBookkeepingWrite } from './claude-code-bookkeeping';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('bookkeeping');
});
afterEach(() => {
  dir.cleanup();
});

const lock = '.claude/scheduled_tasks.lock';

describe('the Claude Code bookkeeping list', () => {
  it('names the Claude Code behaviour that writes each entry', () => {
    expect(CLAUDE_CODE_BOOKKEEPING.length).toBeGreaterThan(0);
    for (const entry of CLAUDE_CODE_BOOKKEEPING) {
      expect(entry.path).toMatch(/^\.claude\//);
      expect(entry.writtenBy.length).toBeGreaterThan(20);
    }
  });

  it('holds no path that changes what a session may do', () => {
    const risky = /settings|hooks|agents|skills|commands|\.mcp|CLAUDE\.md/;
    for (const entry of CLAUDE_CODE_BOOKKEEPING) expect(entry.path).not.toMatch(risky);
  });
});

describe('ignoredBookkeepingWrite', () => {
  it('ignores the scheduled-tasks lock as a file and when it is gone', () => {
    mkdirSync(join(dir.path, '.claude'));
    expect(ignoredBookkeepingWrite(dir.path, lock)?.path).toBe(lock);
    writeFileSync(join(dir.path, lock), '{}');
    expect(ignoredBookkeepingWrite(dir.path, lock)).not.toBeNull();
  });

  it('does not ignore the lock as a link', () => {
    mkdirSync(join(dir.path, '.claude'));
    symlinkSync(join(dir.path, 'elsewhere'), join(dir.path, lock));
    expect(ignoredBookkeepingWrite(dir.path, lock)).toBeNull();
  });

  it('does not ignore the lock as a directory', () => {
    mkdirSync(join(dir.path, lock), { recursive: true });
    expect(ignoredBookkeepingWrite(dir.path, lock)).toBeNull();
  });

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/pre.sh',
    '.claude/agents/a.md',
    '.claude/skills/s/SKILL.md',
    '.claude/x/scheduled_tasks.lock',
    '.claude/scheduled_tasks.lockx',
    'scheduled_tasks.lock',
    '.claude/scheduled_tasks.json',
  ])('does not ignore %s', (rel) => {
    expect(ignoredBookkeepingWrite(dir.path, rel)).toBeNull();
  });
});
