import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { INSTRUCTIONS_MAX_CHARS, readInstructions, type Instructions } from './instructions';
import { leftOutNote } from './left-out';

let root: TempDir;
let checkout: string;
let home: string;
let elsewhere: string;

beforeEach(() => {
  root = tempDir('instructions');
  const base = realpathSync(root.path);
  checkout = join(base, 'checkout');
  home = join(base, 'home');
  elsewhere = join(base, 'dotfiles');
  for (const dir of [checkout, join(home, '.claude'), elsewhere])
    mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  root.cleanup();
});

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function headings(result: Instructions): string[] {
  return (result.text ?? '').split('\n').filter((line) => line.startsWith('## '));
}

function read(
  opts: { project?: boolean; yours?: boolean; laneWritable?: string[] } = {},
): Instructions {
  return readInstructions({
    checkout,
    home,
    project: opts.project ?? true,
    yours: opts.yours ?? true,
    laneWritable: opts.laneWritable ?? [checkout],
  });
}

function writeAll(): void {
  write(join(checkout, 'AGENTS.md'), 'agents text');
  write(join(checkout, 'CLAUDE.md'), 'claude text');
  write(join(checkout, '.claude/rules/b.md'), 'rule b');
  write(join(checkout, '.claude/rules/a.md'), 'rule a');
  write(join(home, '.claude/CLAUDE.md'), 'yours text');
}

describe('readInstructions', () => {
  it('both on: AGENTS.md, CLAUDE.md, rules in name order, then yours', () => {
    writeAll();
    const result = read();
    expect(headings(result)).toEqual([
      '## Project instructions (AGENTS.md)',
      '## Project instructions (CLAUDE.md)',
      '## Project rule (.claude/rules/a.md)',
      '## Project rule (.claude/rules/b.md)',
      '## Your instructions (~/.claude/CLAUDE.md)',
    ]);
    expect(result.sources).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/rules/a.md',
      '.claude/rules/b.md',
      '~/.claude/CLAUDE.md',
    ]);
    expect(result.text).toContain('agents text');
    expect(result.text).toContain('yours text');
    expect(result.leftOut).toEqual([]);
  });

  it('project off: only yours', () => {
    writeAll();
    expect(headings(read({ project: false }))).toEqual([
      '## Your instructions (~/.claude/CLAUDE.md)',
    ]);
  });

  it('yours off: only the project’s', () => {
    writeAll();
    const result = read({ yours: false });
    expect(headings(result)).toHaveLength(4);
    expect(result.text).not.toContain('yours text');
  });

  it('nothing to read is null text', () => {
    expect(read()).toEqual({ text: null, sources: [], leftOut: [] });
  });

  it('opens with the precedence line', () => {
    writeAll();
    expect(read().text?.split('\n')[0]).toBe(
      "These are the project's and the builder's own instructions, which Claude Code would load itself. " +
        "Follow them, except where 10db's brief for this session says otherwise: 10db's rules on commits, " +
        'pushes, claims and the gate come first.',
    );
  });

  it('a CLAUDE.md that is a link is left out, naming why', () => {
    write(join(elsewhere, 'secret.md'), 'not for the prompt');
    symlinkSync(join(elsewhere, 'secret.md'), join(checkout, 'CLAUDE.md'));
    write(join(checkout, 'AGENTS.md'), 'agents text');
    const result = read({ yours: false });
    expect(result.text).not.toContain('not for the prompt');
    expect(result.leftOut).toEqual([
      { what: 'CLAUDE.md', why: 'it must be a regular file, not a link' },
    ]);
  });

  it('a .claude/rules that is a link is left out, naming why', () => {
    write(join(elsewhere, 'r.md'), 'not for the prompt');
    mkdirSync(join(checkout, '.claude'));
    symlinkSync(elsewhere, join(checkout, '.claude/rules'));
    const result = read({ yours: false });
    expect(result.text).toBeNull();
    expect(result.leftOut).toEqual([{ what: '.claude/rules', why: 'it is a link' }]);
  });

  it('a 300 KiB AGENTS.md is left out, and the rest load', () => {
    write(join(checkout, 'AGENTS.md'), 'x'.repeat(300 * 1024));
    write(join(checkout, 'CLAUDE.md'), 'claude text');
    const result = read({ yours: false });
    expect(headings(result)).toEqual(['## Project instructions (CLAUDE.md)']);
    expect(result.leftOut).toEqual([{ what: 'AGENTS.md', why: 'it is larger than 256 KiB' }]);
  });

  it('past the cap, whole files are left out from the first that does not fit', () => {
    for (const name of ['a', 'b', 'c'])
      write(join(checkout, `.claude/rules/${name}.md`), name.repeat(30_000));
    write(join(home, '.claude/CLAUDE.md'), 'small');
    const result = read();
    expect(headings(result)).toEqual([
      '## Project rule (.claude/rules/a.md)',
      '## Project rule (.claude/rules/b.md)',
    ]);
    expect(result.text?.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(result.text).toContain('b'.repeat(30_000));
    expect(result.leftOut).toEqual([
      { what: '.claude/rules/c.md', why: 'over the size 10db puts in a system prompt' },
      { what: '~/.claude/CLAUDE.md', why: 'over the size 10db puts in a system prompt' },
    ]);
  });

  it('the builder’s file through a link to a dotfiles folder loads', () => {
    write(join(elsewhere, 'CLAUDE.md'), 'from dotfiles');
    symlinkSync(join(elsewhere, 'CLAUDE.md'), join(home, '.claude/CLAUDE.md'));
    const result = read();
    expect(headings(result)).toEqual(['## Your instructions (~/.claude/CLAUDE.md)']);
    expect(result.text).toContain('from dotfiles');
  });

  it('the builder’s file whose real path is in a checkout is left out', () => {
    write(join(checkout, 'notes.md'), 'lane written');
    symlinkSync(join(checkout, 'notes.md'), join(home, '.claude/CLAUDE.md'));
    const result = read({ project: false });
    expect(result.text).toBeNull();
    expect(result.leftOut).toEqual([
      { what: '~/.claude/CLAUDE.md', why: 'it leads into a folder a lane can write' },
    ]);
  });
});

describe('leftOutNote', () => {
  it('none is null', () => {
    expect(leftOutNote([])).toBeNull();
  });

  it('two items, one line each, in order', () => {
    expect(
      leftOutNote([
        { what: 'CLAUDE.md', why: 'it must be a regular file, not a link' },
        { what: 'skill x', why: 'no SKILL.md' },
      ]),
    ).toBe(
      'Note from 10db: left out of this session:\n' +
        '- CLAUDE.md: it must be a regular file, not a link\n' +
        '- skill x: no SKILL.md',
    );
  });
});
