import { join, relative, sep } from 'node:path';
import { foldPathCase } from '../guard';
import { isEqualOrUnder } from './protected-reads';

/** The folders of the builder's setup a lane may read inside otherwise closed ground. */
export function setupReadRoots(home: string): string[] {
  return [
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'plugins'),
    join(home, '.agents', 'skills'),
  ];
}

/** What a setup read is judged against, every path real. */
export interface SetupReadContext {
  readonly home: string;
  readonly protectedReads: readonly string[];
  readonly secretFiles: readonly string[];
  readonly sandboxRoots: readonly string[];
  /** Every checkout, the worktree root and every lane temp root. */
  readonly laneWritable: readonly string[];
}

const holdsAny = (path: string, others: readonly string[]): boolean =>
  others.some((other) => isEqualOrUnder(other, path));
const underAny = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => isEqualOrUnder(path, root));

/**
 * Whether a skill's or plugin's real path may open read-only to a lane: null when it may, else why not.
 * Under the home only a folder two or more levels down opens, and never one under `~/Library` or a hidden
 * folder of the home, so a credential folder (`~/.ssh`, `~/.aws`, `~/.config/gh`) is refused by where it
 * is, not by name. Nothing that is, holds or lies under a protected read, a secret file, a sandbox root or
 * ground a lane can write opens.
 */
export function setupReadRefusal(real: string, ctx: SetupReadContext): string | null {
  if (isEqualOrUnder(ctx.home, real)) return 'it is your home folder or holds it';
  const roots = setupReadRoots(ctx.home);
  const inRoots = underAny(real, roots);
  if (isEqualOrUnder(real, ctx.home) && !inRoots) {
    const parts = relative(foldPathCase(ctx.home), foldPathCase(real)).split(sep);
    if (parts.length < 2) return 'it lies directly in your home folder';
    const top = parts[0] ?? '';
    if (top === 'library' || top === 'Library' || top.startsWith('.'))
      return 'it lies under ~/Library or a hidden folder of your home';
  }
  if (!inRoots && underAny(real, ctx.protectedReads))
    return 'it lies in a folder 10db keeps closed';
  if (holdsAny(real, ctx.protectedReads)) return 'it holds a folder 10db keeps closed';
  if (underAny(real, ctx.secretFiles) || holdsAny(real, ctx.secretFiles))
    return 'it is or holds a secrets file';
  if (underAny(real, ctx.sandboxRoots) || holdsAny(real, ctx.sandboxRoots))
    return "it is or holds a folder where 10db keeps sandboxes' files";
  if (underAny(real, ctx.laneWritable) || holdsAny(real, ctx.laneWritable))
    return 'it lies in, or holds, a folder a lane can write';
  return null;
}

/** Sorted and deduplicated, with every path that lies under another left out. */
export function collapseReads(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort();
  const kept: string[] = [];
  for (const path of sorted) if (!kept.some((root) => isEqualOrUnder(path, root))) kept.push(path);
  return kept;
}
