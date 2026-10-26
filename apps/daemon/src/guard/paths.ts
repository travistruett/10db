import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, matchesGlob, parse, relative, resolve, sep } from 'node:path';
import type { AreaDef, HazardDef } from '@10db/contracts';

const MAX_LINK_HOPS = 40;

/** Whether the file system folds case, so `PACKAGE.JSON` and `package.json` are the same file. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** A path cannot be resolved the way the kernel would: a link loop, or `..` past a missing part. */
export class PathResolutionError extends Error {
  override readonly name = 'PathResolutionError';
}

/**
 * Resolves `p` the way the kernel opens it, without requiring it to exist. A resolved directory
 * and a queue of components that remain are kept: `.` is skipped, `..` goes to the resolved
 * directory's parent, and a link's target components go to the front of the queue (an absolute
 * target restarts at its root). A link, even a dangling one, is therefore followed through its
 * target, and a `..` inside a link target applies to where the link really leads. Components after
 * the first missing one are appended as written; a `..` among them throws, as the kernel would
 * fail it. A path that cannot be examined (EACCES, ENOTDIR) or loops through links throws.
 */
function resolveThroughLinks(p: string): string {
  let directory = parse(p).root;
  const queue = p.slice(directory.length).split(sep);
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift();
    if (part === undefined || part === '' || part === '.') continue;
    if (part === '..') {
      directory = dirname(directory);
      continue;
    }
    const next = join(directory, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (!isMissing(error)) throw error;
      const tail = [part, ...queue].filter((name) => name !== '' && name !== '.');
      if (tail.includes('..')) {
        throw new PathResolutionError(`${p} climbs with .. past a part that does not exist`);
      }
      return join(realpathSync.native(directory), ...tail);
    }
    if (!isLink) {
      directory = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) throw new PathResolutionError(`${p} passes through too many links`);
    const target = readlinkSync(next);
    if (isAbsolute(target)) directory = parse(target).root;
    queue.unshift(...target.slice(parse(target).root.length).split(sep));
  }
  return realpathSync.native(directory);
}

/** The real path `p` names, following links through every existing component; `p` need not exist. Throws when a component cannot be examined (EACCES, ENOTDIR), a `..` follows a missing part, or links loop. */
export function realPathOf(p: string): string {
  return resolveThroughLinks(p);
}

/**
 * The repo-relative paths a file path names, read both ways: as the kernel opens it (links resolve
 * as they are met, and `..` follows them), and with `..` collapsed as text first. Inside only when
 * both readings are inside; a path that cannot be examined (not a directory, no permission, a link
 * loop, `..` past a missing part) is treated as outside.
 */
export function resolveInRepoReadings(
  repoPath: string,
  filePath: string,
): { inside: true; rels: string[] } | { inside: false } {
  try {
    const root = realpathSync.native(repoPath);
    const base = resolve(repoPath);
    const readings = [
      resolveThroughLinks(isAbsolute(filePath) ? filePath : `${base}${sep}${filePath}`),
      resolveThroughLinks(resolve(base, filePath)),
    ];
    const rels: string[] = [];
    for (const target of readings) {
      const rel = relative(root, target);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { inside: false };
      }
      if (!rels.includes(rel)) rels.push(rel);
    }
    return { inside: true, rels };
  } catch {
    return { inside: false };
  }
}

/** The path relative to the repo when every reading of `filePath` is inside it (see `resolveInRepoReadings`). */
export function resolveInRepo(
  repoPath: string,
  filePath: string,
): { inside: true; rel: string } | { inside: false } {
  const where = resolveInRepoReadings(repoPath, filePath);
  const [rel] = where.inside ? where.rels : [];
  return rel === undefined ? { inside: false } : { inside: true, rel };
}

/** Folds a path's spelling the way the file system does: Unicode NFC, and lowercase where case is folded. */
export function foldPathCase(text: string): string {
  const composed = text.normalize('NFC');
  return CASE_INSENSITIVE ? composed.toLowerCase() : composed;
}

const fold = foldPathCase;

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
