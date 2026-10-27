import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export const GitMode = {
  File: '100644',
  Executable: '100755',
  Link: '120000',
  Gitlink: '160000',
} as const;
export type GitMode = (typeof GitMode)[keyof typeof GitMode];

/** Characters HFS+ ignores in a name, so `.git` with one inside still opens the git dir there. */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * True when a path component names a git dir on some file system: `.git` in any case, with
 * characters HFS+ ignores, or as NTFS's short name `git~1`.
 */
export function isGitComponent(name: string): boolean {
  const plain = name.replace(HFS_IGNORABLE, '').toLowerCase();
  return plain === '.git' || plain.startsWith('git~1') || /^\.git[. ]+$/.test(plain);
}

/**
 * The first directory on `rel`'s path, `rel` itself included, that holds a `.git` entry: an
 * embedded repository, whose own git would run its own config. A component that names a git dir
 * counts too. Null when there is none.
 */
export function embeddedRepository(repo: string, rel: string): string | null {
  const parts = rel.split(sep).filter((part) => part !== '');
  if (parts.some(isGitComponent)) return rel;
  for (let i = 1; i <= parts.length; i += 1) {
    const dir = parts.slice(0, i).join(sep);
    if (existsSync(join(repo, dir, '.git'))) return dir;
  }
  return null;
}
