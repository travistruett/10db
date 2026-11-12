import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LeftOut } from './left-out';

/** One of the builder's skill folders. */
export interface SkillFolder {
  readonly name: string;
  /** The folder as found under the skills dir; it may be a link. */
  readonly path: string;
  /** The real path of its `SKILL.md`, through any link. */
  readonly skillFile: string;
}

/** The builder's skill dirs, in the order a name is first taken. */
const SKILL_DIRS = [
  ['.claude', 'skills'],
  ['.agents', 'skills'],
] as const;

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

type Found = { readonly skillFile: string } | { readonly refused: string };

function judgeEntry(path: string): Found {
  try {
    if (!statSync(path).isDirectory()) return { refused: 'not a folder' };
  } catch {
    return { refused: 'it leads nowhere' };
  }
  const skillFile = join(path, 'SKILL.md');
  try {
    lstatSync(skillFile);
  } catch {
    return { refused: 'no SKILL.md' };
  }
  try {
    const real = realpathSync.native(skillFile);
    if (!statSync(real).isFile()) return { refused: 'its SKILL.md leads nowhere' };
    return { skillFile: real };
  } catch {
    return { refused: 'its SKILL.md leads nowhere' };
  }
}

/**
 * The builder's skill folders under `~/.claude/skills` then `~/.agents/skills`, the first folder of a name
 * winning. Real paths are not judged here: the lane sandbox judges each folder's and `SKILL.md`'s.
 */
export function findBuilderSkills(home: string): { folders: SkillFolder[]; leftOut: LeftOut[] } {
  const folders: SkillFolder[] = [];
  const leftOut: LeftOut[] = [];
  const firstFrom = new Map<string, string>();
  for (const [top, skills] of SKILL_DIRS) {
    for (const name of entries(join(home, top, skills))) {
      if (name.startsWith('.')) continue;
      const shown = `~/${top}/${skills}/${name}`;
      const path = join(home, top, skills, name);
      const found = judgeEntry(path);
      if ('refused' in found) {
        leftOut.push({ what: shown, why: found.refused });
        continue;
      }
      const first = firstFrom.get(name);
      if (first !== undefined) {
        leftOut.push({ what: shown, why: `a skill named ${name} is already loaded from ${first}` });
        continue;
      }
      firstFrom.set(name, shown);
      folders.push({ name, path, skillFile: found.skillFile });
    }
  }
  return { folders, leftOut };
}
