import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { installedSkillDir } from '../agent-skill';
import { findBuilderSkills } from './builder-skills';

let root: TempDir;
let home: string;

beforeEach(() => {
  root = tempDir('builder-skills');
  home = join(realpathSync(root.path), 'home');
  mkdirSync(home);
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
  it("10db's own skill is left out by real path, saying why, and a plain skill beside it stays", () => {
    const ours = skill(installedSkillDir(home));
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(ours, join(home, '.claude/skills/10db-task'));
    // A link under another name to the same copy is the same skill.
    symlinkSync('../../.10db/skills/10db-task', join(home, '.claude/skills/Renamed'));
    const plain = skill(join(home, '.claude/skills/plain'));
    const reason = "10db's own skill acts for you with the app's token, so it never comes along";
    expect(findBuilderSkills(home)).toEqual({
      folders: [{ name: 'plain', path: plain, skillFile: join(plain, 'SKILL.md') }],
      leftOut: [
        { what: '~/.claude/skills/10db-task', why: reason },
        { what: '~/.claude/skills/Renamed', why: reason },
      ],
    });
  });
});
