import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import type { AreaDef, HazardDef } from '@10db/contracts';

/** Resolves symlinks on the longest existing prefix of `p`, so a symlinked parent can't escape. */
function realpathOfNearest(p: string): string {
  let current = p;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return p;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

export function resolveInRepo(
  repoPath: string,
  filePath: string,
): { inside: true; rel: string } | { inside: false } {
  const root = realpathSync(repoPath);
  const target = realpathOfNearest(isAbsolute(filePath) ? filePath : resolve(repoPath, filePath));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { inside: false };
  return { inside: true, rel };
}

export function classifyPath(
  rel: string,
  areas: readonly AreaDef[],
  hazards: readonly HazardDef[],
): { areas: string[]; hazards: string[] } {
  const hits = (defs: readonly AreaDef[]) =>
    defs.filter((d) => d.globs.some((g) => matchesGlob(rel, g))).map((d) => d.name);
  return { areas: hits(areas), hazards: hits(hazards) };
}
