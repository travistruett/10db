import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { findBuilderSkills } from './builder-skills';

let root: TempDir;
let home: string;
let outside: string;

beforeEach(() => {
  root = tempDir('builder-skills');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  outside = join(base, 'outside');
  mkdirSync(home);
  mkdirSync(outside);
});

afterEach(() => {
  root.cleanup();
});

function skill(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n');
  return dir;
}

describe('findBuilderSkills', () => {
  it('a folder with SKILL.md counts, one without is listed', () => {
    const s = skill(join(home, '.claude/skills/s'));
    mkdirSync(join(home, '.claude/skills/empty'));
    expect(findBuilderSkills(home)).toEqual({
      folders: [{ name: 's', path: s, skillFile: join(s, 'SKILL.md') }],
      leftOut: [{ what: '~/.claude/skills/empty', why: 'no SKILL.md' }],
    });
  });

  it('a link to a folder outside the home counts, as found', () => {
    const target = skill(join(outside, 'mine'));
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(target, join(home, '.claude/skills/linked'));
    expect(findBuilderSkills(home).folders).toEqual([
      {
        name: 'linked',
        path: join(home, '.claude/skills/linked'),
        skillFile: join(target, 'SKILL.md'),
      },
    ]);
  });

  it('a folder whose SKILL.md is a link gives that link’s real path', () => {
    writeFileSync(join(outside, 'real.md'), 'x');
    const dir = join(home, '.claude/skills/s');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, 'real.md'), join(dir, 'SKILL.md'));
    expect(findBuilderSkills(home).folders).toEqual([
      { name: 's', path: dir, skillFile: join(outside, 'real.md') },
    ]);
  });

  it('a SKILL.md link that leads nowhere is listed', () => {
    const dir = join(home, '.claude/skills/s');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, 'gone.md'), join(dir, 'SKILL.md'));
    expect(findBuilderSkills(home)).toEqual({
      folders: [],
      leftOut: [{ what: '~/.claude/skills/s', why: 'its SKILL.md leads nowhere' }],
    });
  });

  it('the same name under ~/.agents/skills is listed, naming the first', () => {
    const first = skill(join(home, '.claude/skills/s'));
    skill(join(home, '.agents/skills/s'));
    const other = skill(join(home, '.agents/skills/t'));
    expect(findBuilderSkills(home)).toEqual({
      folders: [
        { name: 's', path: first, skillFile: join(first, 'SKILL.md') },
        { name: 't', path: other, skillFile: join(other, 'SKILL.md') },
      ],
      leftOut: [
        {
          what: '~/.agents/skills/s',
          why: 'a skill named s is already loaded from ~/.claude/skills/s',
        },
      ],
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'a name that differs only by case or Unicode form is the same skill, as APFS folds it',
    () => {
      const first = skill(join(home, '.claude/skills/Review'));
      skill(join(home, '.agents/skills/review'));
      // `é` composed under ~/.claude, decomposed under ~/.agents.
      const cafe = skill(join(home, '.claude/skills/caf\u00e9'));
      skill(join(home, '.agents/skills/cafe\u0301'));
      expect(findBuilderSkills(home)).toEqual({
        folders: [
          { name: 'Review', path: first, skillFile: join(first, 'SKILL.md') },
          { name: 'caf\u00e9', path: cafe, skillFile: join(cafe, 'SKILL.md') },
        ],
        leftOut: [
          {
            what: '~/.agents/skills/cafe\u0301',
            why: 'a skill named cafe\u0301 is already loaded from ~/.claude/skills/caf\u00e9',
          },
          {
            what: '~/.agents/skills/review',
            why: 'a skill named review is already loaded from ~/.claude/skills/Review',
          },
        ],
      });
    },
  );

  it('a dot entry is skipped and not listed', () => {
    mkdirSync(join(home, '.claude/skills/.git'), { recursive: true });
    writeFileSync(join(home, '.claude/skills/.DS_Store'), '');
    expect(findBuilderSkills(home)).toEqual({ folders: [], leftOut: [] });
  });

  it('no skills dirs is empty', () => {
    expect(findBuilderSkills(home)).toEqual({ folders: [], leftOut: [] });
  });
});
