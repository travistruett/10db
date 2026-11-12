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
 * Whether `real` lies in a setup root: a skills root, or under `~/.claude/plugins` an installed
 * version's folder, `cache/<marketplace>/<plugin>/<version>`, or deeper. The rest of the plugins folder
 * (its list, its marketplaces' clones) is Claude Code's own.
 */
function inSetupRoots(real: string, home: string): boolean {
  const [skills, plugins, agentSkills] = setupReadRoots(home);
  if (underAny(real, [skills ?? '', agentSkills ?? ''])) return true;
  if (plugins === undefined || !isEqualOrUnder(real, plugins)) return false;
  const parts = relative(foldPathCase(plugins), foldPathCase(real)).split(sep);
  return parts[0] === 'cache' && parts.length >= 4;
}

/**
 * Whether closing `real` would close what a session needs: the home or a folder holding it (`/`), or a
 * folder that is or holds ground a lane writes or a sandbox root. A `.env*` link that leads to one
 * can't be denied, so its skill or plugin is left out instead.
 */
export function holdsSessionGround(real: string, ctx: SetupReadContext): boolean {
  return (
    isEqualOrUnder(ctx.home, real) ||
    holdsAny(real, ctx.laneWritable) ||
    holdsAny(real, ctx.sandboxRoots)
  );
}

/**
 * Whether a skill's or plugin's real path may open read-only to a lane: null when it may, else why not.
 * Under the home only a folder two or more levels down opens, and never one under `~/Library` or a hidden
 * folder of the home, so a credential folder (`~/.ssh`, `~/.aws`, `~/.config/gh`) is refused by where it
 * is, not by name. Nothing that is, holds or lies under a protected read, a secret file, a sandbox root or
 * ground a lane can write opens.
 */
export function setupReadRefusal(real: string, ctx: SetupReadContext): string | null {
  if (isEqualOrUnder(ctx.home, real)) return 'it is your home folder or holds it';
  const inRoots = inSetupRoots(real, ctx.home);
  if (isEqualOrUnder(real, ctx.home) && !inRoots) {
    const parts = relative(foldPathCase(ctx.home), foldPathCase(real)).split(sep);
    const top = parts[0] ?? '';
    if (top === 'library' || top === 'Library' || top.startsWith('.'))
      return 'it lies under ~/Library or a hidden folder of your home';
    if (parts.length < 2) return 'it lies directly in your home folder';
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
