import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, matchesGlob, parse, relative, resolve, sep } from 'node:path';
import type { AreaDef, HazardDef } from '@10db/contracts';

const MAX_LINK_HOPS = 40;

/** Whether the file system folds case, so `PACKAGE.JSON` and `package.json` are the same file. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Resolves `p` to the path it really names, without requiring it to exist. Every existing
 * component is resolved (symlinks, including dangling ones, are followed through their targets),
 * and the part that does not exist yet is appended as written. A symlinked parent or a link to a
 * file that has not been created therefore cannot hide where a write would land.
 */
function resolveThroughLinks(p: string, hops = 0): string {
  if (hops > MAX_LINK_HOPS) return p;
  const { root } = parse(p);
  const parts = p.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    const next = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (!isMissing(error)) throw error;
      return join(realpathSync.native(current), ...parts.slice(index));
    }
    if (isLink) {
      const target = resolve(dirname(next), readlinkSync(next));
      return resolveThroughLinks(resolve(target, ...parts.slice(index + 1)), hops + 1);
    }
    current = next;
  }
  return realpathSync.native(current);
}

export function resolveInRepo(
  repoPath: string,
  filePath: string,
): { inside: true; rel: string } | { inside: false } {
  const root = realpathSync.native(repoPath);
  const target = resolveThroughLinks(resolve(repoPath, filePath));
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { inside: false };
  }
  return { inside: true, rel };
}

const fold = (text: string): string => (CASE_INSENSITIVE ? text.toLowerCase() : text);

export function classifyPath(
  rel: string,
  areas: readonly AreaDef[],
  hazards: readonly HazardDef[],
): { areas: string[]; hazards: string[] } {
  const path = fold(rel);
  const hits = (defs: readonly AreaDef[]) =>
    defs.filter((d) => d.globs.some((g) => matchesGlob(path, fold(g)))).map((d) => d.name);
  return { areas: hits(areas), hazards: hits(hazards) };
}
